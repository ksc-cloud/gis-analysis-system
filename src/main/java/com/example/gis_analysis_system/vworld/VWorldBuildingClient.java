package com.example.gis_analysis_system.vworld;

import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
 * Looks up road-address buildings (LT_C_SPBD) through the VWorld 2D data API.
 * The API key stays on the server; VWorld does not send CORS headers, so the browser cannot call it directly.
 */
@Component
public class VWorldBuildingClient {

	static final String DATA_API_URL = "https://api.vworld.kr/req/data";

	static final String BUILDING_LAYER = "LT_C_SPBD";

	static final int MAX_FEATURES = 5;

	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);

	private static final Duration READ_TIMEOUT = Duration.ofSeconds(5);

	private static final Logger logger = LoggerFactory.getLogger(VWorldBuildingClient.class);

	private final RestClient restClient;

	private final JsonMapper jsonMapper;

	private final String apiKey;

	private final String domain;

	@Autowired
	public VWorldBuildingClient(JsonMapper jsonMapper, @Value("${vworld.api-key:}") String apiKey,
			@Value("${vworld.domain:}") String domain) {
		this(RestClient.builder().requestFactory(requestFactory()), jsonMapper, apiKey, domain);
	}

	VWorldBuildingClient(RestClient.Builder restClientBuilder, JsonMapper jsonMapper, String apiKey, String domain) {
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

	public boolean isConfigured() {
		return StringUtils.hasText(this.apiKey);
	}

	/**
	 * Finds the LT_C_SPBD buildings whose footprint contains the given WGS84 point.
	 */
	public BuildingLookupResult findBuildingsAt(double lon, double lat) {
		if (!isConfigured()) {
			throw new VWorldApiException(VWorldApiException.Reason.API_KEY_MISSING, null,
					"VWorld API 키가 설정되지 않았습니다.");
		}
		return parse(fetch(buildUri(lon, lat)));
	}

	URI buildUri(double lon, double lat) {
		UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(DATA_API_URL)
			.queryParam("service", "data")
			.queryParam("request", "GetFeature")
			.queryParam("data", BUILDING_LAYER)
			.queryParam("key", this.apiKey)
			.queryParam("format", "json")
			.queryParam("crs", "EPSG:4326")
			.queryParam("geomFilter", "POINT(" + lon + " " + lat + ")")
			.queryParam("geometry", "false")
			.queryParam("attribute", "true")
			.queryParam("size", MAX_FEATURES)
			.queryParam("page", 1);
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
			logger.warn("VWorld data API returned HTTP {}", ex.getStatusCode().value());
			throw new VWorldApiException(VWorldApiException.Reason.API_ERROR, "HTTP_" + ex.getStatusCode().value(),
					"VWorld 데이터 API가 오류 응답을 반환했습니다.");
		}
		catch (ResourceAccessException ex) {
			Throwable cause = ex.getMostSpecificCause();
			logger.warn("VWorld data API request failed: {}", cause.getClass().getSimpleName());
			if (cause instanceof SocketTimeoutException || cause instanceof HttpTimeoutException) {
				throw new VWorldApiException(VWorldApiException.Reason.TIMEOUT, null,
						"VWorld 데이터 API 응답 시간이 초과되었습니다.");
			}
			throw new VWorldApiException(VWorldApiException.Reason.NETWORK_ERROR, null,
					"VWorld 데이터 API에 연결할 수 없습니다.");
		}
		catch (RestClientException ex) {
			logger.warn("VWorld data API request failed: {}", ex.getClass().getSimpleName());
			throw new VWorldApiException(VWorldApiException.Reason.NETWORK_ERROR, null,
					"VWorld 데이터 API 호출에 실패했습니다.");
		}
	}

	BuildingLookupResult parse(String body) {
		JsonNode response;
		try {
			response = this.jsonMapper.readTree((body != null) ? body : "").path("response");
		}
		catch (JacksonException ex) {
			throw unexpectedResponse("JSON이 아닌 응답");
		}

		String status = text(response.path("status"));
		if ("NOT_FOUND".equals(status)) {
			return BuildingLookupResult.notFound();
		}
		if ("ERROR".equals(status)) {
			JsonNode error = response.path("error");
			String code = text(error.path("code"));
			String message = text(error.path("text"));
			logger.warn("VWorld data API error: {}", code);
			throw new VWorldApiException(VWorldApiException.Reason.API_ERROR, code,
					(message != null) ? message : "VWorld 데이터 API가 오류를 반환했습니다.");
		}
		if (!"OK".equals(status)) {
			throw unexpectedResponse("알 수 없는 status");
		}

		// The structure below result is not shown in the official guide; it was confirmed with a real key
		// (VWorldApiKeyLiveTests). Any other structure is rejected instead of being guessed.
		JsonNode features = response.path("result").path("featureCollection").path("features");
		if (!features.isArray()) {
			throw unexpectedResponse("result.featureCollection.features 없음");
		}

		Map<String, BuildingInfo> distinct = new LinkedHashMap<>();
		List<BuildingInfo> withoutId = new ArrayList<>();
		for (JsonNode feature : features) {
			JsonNode properties = feature.path("properties");
			if (!properties.isObject()) {
				throw unexpectedResponse("properties 없음");
			}
			BuildingInfo building = toBuilding(properties);
			if (building.buildingManagementNumber() != null) {
				distinct.putIfAbsent(building.buildingManagementNumber(), building);
			}
			else {
				withoutId.add(building);
			}
		}
		List<BuildingInfo> buildings = new ArrayList<>(distinct.values());
		buildings.addAll(withoutId);

		int totalCount = response.path("record").path("total").asInt(features.size());
		if (buildings.isEmpty()) {
			return BuildingLookupResult.notFound();
		}
		boolean exactlyOne = buildings.size() == 1 && totalCount <= features.size();
		return new BuildingLookupResult(
				exactlyOne ? BuildingLookupResult.Status.FOUND : BuildingLookupResult.Status.AMBIGUOUS,
				Math.max(totalCount, buildings.size()), List.copyOf(buildings));
	}

	private static BuildingInfo toBuilding(JsonNode p) {
		return new BuildingInfo(text(p.path("bd_mgt_sn")), text(p.path("buld_nm")), text(p.path("buld_nm_dc")),
				text(p.path("gro_flo_co")), text(p.path("sido")), text(p.path("sigungu")), text(p.path("gu")),
				text(p.path("rd_nm")), text(p.path("buld_no")));
	}

	private static String text(JsonNode node) {
		if (node == null || node.isMissingNode() || node.isNull() || !node.isValueNode()) {
			return null;
		}
		String value = node.asString().trim();
		return value.isEmpty() ? null : value;
	}

	private static VWorldApiException unexpectedResponse(String detail) {
		logger.warn("Unexpected VWorld data API response: {}", detail);
		return new VWorldApiException(VWorldApiException.Reason.UNEXPECTED_RESPONSE, null,
				"VWorld 데이터 API 응답 형식을 확인할 수 없습니다.");
	}

}
