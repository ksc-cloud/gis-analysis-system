package com.example.gis_analysis_system.vworld;

import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.util.UriComponentsBuilder;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Searches places and addresses through the VWorld Search API 2.0 ({@code /req/search}).
 * The API key stays on the server, like the data API calls of {@link VWorldBuildingClient}.
 * <p>
 * The response structure below was confirmed with the configured key (place, road address, parcel address and
 * NOT_FOUND responses): {@code response.result.items[]} with {@code point.x/y} as strings in EPSG:4326, place items
 * with {@code title}, {@code category}, {@code address.road/parcel}, address items with
 * {@code address.road/parcel/bldnm/bldnmdc}.
 */
@Component
public class VWorldSearchClient {

	static final String SEARCH_API_URL = "https://api.vworld.kr/req/search";

	public static final int PAGE_SIZE = 10;

	// Approximate WGS84 bounds of South Korea (same as the building API).
	static final double MIN_LON = 124.0;

	static final double MAX_LON = 132.0;

	static final double MIN_LAT = 33.0;

	static final double MAX_LAT = 39.0;

	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);

	private static final Duration READ_TIMEOUT = Duration.ofSeconds(5);

	private static final Logger logger = LoggerFactory.getLogger(VWorldSearchClient.class);

	/** What is searched: VWorld {@code type} and {@code category} parameters. */
	public enum SearchType {

		/** Places and buildings by name (POI). */
		PLACE("place", null, null),

		/** Road name addresses. Results carry the building name of the address when it has one. */
		ROAD("address", "road", "도로명 주소"),

		/** Parcel (jibun) addresses. */
		PARCEL("address", "parcel", "지번 주소");

		private final String type;

		private final String category;

		private final String label;

		SearchType(String type, String category, String label) {
			this.type = type;
			this.category = category;
			this.label = label;
		}

	}

	private final RestClient restClient;

	private final JsonMapper jsonMapper;

	private final String apiKey;

	private final String domain;

	@Autowired
	public VWorldSearchClient(JsonMapper jsonMapper, @Value("${vworld.api-key:}") String apiKey,
			@Value("${vworld.domain:}") String domain) {
		this(RestClient.builder().requestFactory(requestFactory()), jsonMapper, apiKey, domain);
	}

	VWorldSearchClient(RestClient.Builder restClientBuilder, JsonMapper jsonMapper, String apiKey, String domain) {
		this.restClient = restClientBuilder.build();
		this.jsonMapper = jsonMapper;
		this.apiKey = (apiKey != null) ? apiKey.trim() : "";
		this.domain = (domain != null) ? domain.trim() : "";
	}

	private static SimpleClientHttpRequestFactory requestFactory() {
		SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
		requestFactory.setConnectTimeout(CONNECT_TIMEOUT);
		requestFactory.setReadTimeout(READ_TIMEOUT);
		return requestFactory;
	}

	public SearchResult search(String query, SearchType type, int page) {
		if (!StringUtils.hasText(this.apiKey)) {
			throw new VWorldApiException(VWorldApiException.Reason.API_KEY_MISSING, null,
					"VWorld API 키가 설정되지 않았습니다.");
		}
		return parse(fetch(buildUri(query, type, page)), type, page);
	}

	URI buildUri(String query, SearchType type, int page) {
		UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(SEARCH_API_URL)
			.queryParam("service", "search")
			.queryParam("request", "search")
			.queryParam("version", "2.0")
			.queryParam("crs", "EPSG:4326")
			.queryParam("size", PAGE_SIZE)
			.queryParam("page", page)
			.queryParam("query", query)
			.queryParam("type", type.type)
			.queryParam("format", "json")
			.queryParam("errorformat", "json")
			.queryParam("key", this.apiKey);
		if (type.category != null) {
			builder.queryParam("category", type.category);
		}
		if (StringUtils.hasText(this.domain)) {
			builder.queryParam("domain", this.domain);
		}
		return builder.encode().build().toUri();
	}

	private String fetch(URI uri) {
		// Never log the URI or the exception message: both contain the API key.
		try {
			return this.restClient.get().uri(uri).accept(MediaType.APPLICATION_JSON).retrieve().body(String.class);
		}
		catch (RestClientResponseException ex) {
			logger.warn("VWorld search API returned HTTP {}", ex.getStatusCode().value());
			throw new VWorldApiException(VWorldApiException.Reason.API_ERROR, "HTTP_" + ex.getStatusCode().value(),
					"VWorld 검색 API가 오류 응답을 반환했습니다.");
		}
		catch (ResourceAccessException ex) {
			Throwable cause = ex.getMostSpecificCause();
			logger.warn("VWorld search API request failed: {}", cause.getClass().getSimpleName());
			if (cause instanceof SocketTimeoutException || cause instanceof HttpTimeoutException) {
				throw new VWorldApiException(VWorldApiException.Reason.TIMEOUT, null,
						"VWorld 검색 API 응답 시간이 초과되었습니다.");
			}
			throw new VWorldApiException(VWorldApiException.Reason.NETWORK_ERROR, null,
					"VWorld 검색 API에 연결할 수 없습니다.");
		}
		catch (RestClientException ex) {
			logger.warn("VWorld search API request failed: {}", ex.getClass().getSimpleName());
			throw new VWorldApiException(VWorldApiException.Reason.NETWORK_ERROR, null,
					"VWorld 검색 API 호출에 실패했습니다.");
		}
	}

	SearchResult parse(String body, SearchType type, int page) {
		JsonNode response;
		try {
			response = this.jsonMapper.readTree((body != null) ? body : "").path("response");
		}
		catch (JacksonException ex) {
			throw unexpectedResponse("JSON이 아닌 응답");
		}
		String status = text(response.path("status"));
		if ("NOT_FOUND".equals(status)) {
			return SearchResult.notFound(page);
		}
		if ("ERROR".equals(status)) {
			JsonNode error = response.path("error");
			String code = text(error.path("code"));
			String message = text(error.path("text"));
			logger.warn("VWorld search API error: {}", code);
			throw new VWorldApiException(VWorldApiException.Reason.API_ERROR, code,
					(message != null) ? message : "VWorld 검색 API가 오류를 반환했습니다.");
		}
		if (!"OK".equals(status)) {
			throw unexpectedResponse("알 수 없는 status");
		}
		JsonNode items = response.path("result").path("items");
		if (!items.isArray()) {
			throw unexpectedResponse("result.items 없음");
		}
		List<SearchResult.Item> parsed = new ArrayList<>();
		int skipped = 0;
		for (JsonNode item : items) {
			SearchResult.Item converted = toItem(item, type);
			if (converted == null) {
				skipped++;
			}
			else {
				parsed.add(converted);
			}
		}
		if (skipped > 0) {
			logger.warn("VWorld search API: {} result(s) without valid coordinates skipped", skipped);
		}
		return new SearchResult(true, intValue(response.path("record").path("total")),
				intValue(response.path("page").path("total")), page, List.copyOf(parsed), skipped);
	}

	private static SearchResult.Item toItem(JsonNode item, SearchType type) {
		Double lon = coordinate(item.path("point").path("x"));
		Double lat = coordinate(item.path("point").path("y"));
		if (lon == null || lat == null || lon < MIN_LON || lon > MAX_LON || lat < MIN_LAT || lat > MAX_LAT) {
			return null;
		}
		JsonNode address = item.path("address");
		String road = text(address.path("road"));
		String parcel = text(address.path("parcel"));
		String title;
		String subtitle;
		String category;
		if (type == SearchType.PLACE) {
			title = text(item.path("title"));
			subtitle = (road != null) ? road : parcel;
			category = text(item.path("category"));
		}
		else {
			String buildingName = joinWithSpace(text(address.path("bldnm")), text(address.path("bldnmdc")));
			String main = (type == SearchType.ROAD) ? road : parcel;
			String other = (type == SearchType.ROAD) ? parcel : road;
			title = (main != null) ? main : buildingName;
			subtitle = join(buildingName != null && !buildingName.equals(title) ? buildingName : null, other);
			category = type.label;
		}
		if (title == null) {
			return null;
		}
		return new SearchResult.Item(text(item.path("id")), title, subtitle, category, road, parcel, lon, lat);
	}

	private static String joinWithSpace(String name, String detail) {
		if (name == null) {
			return detail;
		}
		return (detail == null) ? name : name + " " + detail;
	}

	private static String join(String first, String second) {
		if (first == null) {
			return second;
		}
		return (second == null) ? first : first + " · " + second;
	}

	private static Double coordinate(JsonNode node) {
		String value = text(node);
		if (value == null) {
			return null;
		}
		try {
			double parsed = Double.parseDouble(value);
			return Double.isFinite(parsed) ? parsed : null;
		}
		catch (NumberFormatException ex) {
			return null;
		}
	}

	private static int intValue(JsonNode node) {
		String value = text(node);
		if (value == null || !value.matches("\\d{1,9}")) {
			return -1;
		}
		return Integer.parseInt(value);
	}

	private static String text(JsonNode node) {
		if (node == null || node.isMissingNode() || node.isNull() || !node.isValueNode()) {
			return null;
		}
		String value = node.asString().trim();
		return value.isEmpty() ? null : value;
	}

	private static VWorldApiException unexpectedResponse(String detail) {
		logger.warn("Unexpected VWorld search API response: {}", detail);
		return new VWorldApiException(VWorldApiException.Reason.UNEXPECTED_RESPONSE, null,
				"VWorld 검색 API 응답 형식을 확인할 수 없습니다.");
	}

}
