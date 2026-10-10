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

	/** Largest page size accepted by VWorld (size=1001 is rejected with INVALID_RANGE). */
	public static final int MAX_PAGE_SIZE = 1000;

	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);

	private static final Duration READ_TIMEOUT = Duration.ofSeconds(5);

	/** Radius pages carry geometry (about 0.6 MB per 1000 features), so they get a longer read timeout. */
	private static final Duration RADIUS_READ_TIMEOUT = Duration.ofSeconds(10);

	private static final Logger logger = LoggerFactory.getLogger(VWorldBuildingClient.class);

	private final RestClient restClient;

	private final RestClient radiusRestClient;

	private final JsonMapper jsonMapper;

	private final String apiKey;

	private final String domain;

	@Autowired
	public VWorldBuildingClient(JsonMapper jsonMapper, @Value("${vworld.api-key:}") String apiKey,
			@Value("${vworld.domain:}") String domain) {
		this(RestClient.builder().requestFactory(requestFactory(READ_TIMEOUT)),
				RestClient.builder().requestFactory(requestFactory(RADIUS_READ_TIMEOUT)), jsonMapper, apiKey, domain);
	}

	VWorldBuildingClient(RestClient.Builder restClientBuilder, JsonMapper jsonMapper, String apiKey, String domain) {
		this(restClientBuilder, restClientBuilder, jsonMapper, apiKey, domain);
	}

	private VWorldBuildingClient(RestClient.Builder pointBuilder, RestClient.Builder radiusBuilder,
			JsonMapper jsonMapper, String apiKey, String domain) {
		this.restClient = pointBuilder.build();
		this.radiusRestClient = radiusBuilder.build();
		this.jsonMapper = jsonMapper;
		this.apiKey = (apiKey != null) ? apiKey.trim() : "";
		this.domain = (domain != null) ? domain.trim() : "";
	}

	private static SimpleClientHttpRequestFactory requestFactory(Duration readTimeout) {
		SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
		requestFactory.setConnectTimeout(CONNECT_TIMEOUT);
		requestFactory.setReadTimeout(readTimeout);
		return requestFactory;
	}

	public boolean isConfigured() {
		return StringUtils.hasText(this.apiKey);
	}

	/**
	 * Finds the LT_C_SPBD buildings whose footprint contains the given WGS84 point.
	 */
	public BuildingLookupResult findBuildingsAt(double lon, double lat) {
		requireKey();
		return parse(fetch(this.restClient, buildUri(lon, lat)));
	}

	/**
	 * Fetches one page of LT_C_SPBD features whose footprint intersects the circle around the point
	 * ({@code geomFilter=POINT} with {@code buffer} in meters, geometry included).
	 * VWorld's buffer match was checked with a real key: it returned footprints crossing the circle edge
	 * and none farther than the radius. The caller still re-checks every footprint.
	 */
	public FeaturePage findBuildingsWithin(double lon, double lat, int radiusMeters, int page) {
		requireKey();
		return parseFeaturePage(fetch(this.radiusRestClient, buildRadiusUri(lon, lat, radiusMeters, page)), page);
	}

	/**
	 * One page of a radius query.
	 *
	 * @param reportedTotal record.total, or -1 when VWorld did not report it
	 * @param totalPages page.total, or -1 when not reported
	 * @param currentPage page.current, or -1 when not reported. VWorld answers a page beyond the last one with
	 * the last page (checked with a real key), so the caller compares this with the requested page
	 * @param features the features of this page in response order
	 */
	public record FeaturePage(int reportedTotal, int totalPages, int currentPage, List<BuildingFeature> features) {
	}

	URI buildUri(double lon, double lat) {
		return baseUri().queryParam("geomFilter", "POINT(" + lon + " " + lat + ")")
			.queryParam("geometry", "false")
			.queryParam("attribute", "true")
			.queryParam("size", MAX_FEATURES)
			.queryParam("page", 1)
			.encode()
			.build()
			.toUri();
	}

	URI buildRadiusUri(double lon, double lat, int radiusMeters, int page) {
		return baseUri().queryParam("geomFilter", "POINT(" + lon + " " + lat + ")")
			.queryParam("buffer", radiusMeters)
			.queryParam("geometry", "true")
			.queryParam("attribute", "true")
			.queryParam("size", MAX_PAGE_SIZE)
			.queryParam("page", page)
			.encode()
			.build()
			.toUri();
	}

	private UriComponentsBuilder baseUri() {
		UriComponentsBuilder builder = UriComponentsBuilder.fromUriString(DATA_API_URL)
			.queryParam("service", "data")
			.queryParam("request", "GetFeature")
			.queryParam("data", BUILDING_LAYER)
			.queryParam("key", this.apiKey)
			.queryParam("format", "json")
			.queryParam("crs", "EPSG:4326");
		if (StringUtils.hasText(this.domain)) {
			builder.queryParam("domain", this.domain);
		}
		return builder;
	}

	private void requireKey() {
		if (!isConfigured()) {
			throw new VWorldApiException(VWorldApiException.Reason.API_KEY_MISSING, null,
					"VWorld API 키가 설정되지 않았습니다.");
		}
	}

	private String fetch(RestClient client, URI uri) {
		// Never log the URI or the exception message: both contain the API key.
		try {
			return client.get().uri(uri).accept(MediaType.APPLICATION_JSON).retrieve().body(String.class);
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

	/**
	 * Returns {@code response} for status OK, {@code null} for NOT_FOUND, and throws for ERROR or anything else.
	 */
	private JsonNode readResponse(String body) {
		JsonNode response;
		try {
			response = this.jsonMapper.readTree((body != null) ? body : "").path("response");
		}
		catch (JacksonException ex) {
			throw unexpectedResponse("JSON이 아닌 응답");
		}

		String status = text(response.path("status"));
		if ("NOT_FOUND".equals(status)) {
			return null;
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
		return response;
	}

	/**
	 * The structure below result is not shown in the official guide; it was confirmed with a real key
	 * (VWorldApiKeyLiveTests). Any other structure is rejected instead of being guessed.
	 */
	private static JsonNode features(JsonNode response) {
		JsonNode features = response.path("result").path("featureCollection").path("features");
		if (!features.isArray()) {
			throw unexpectedResponse("result.featureCollection.features 없음");
		}
		return features;
	}

	BuildingLookupResult parse(String body) {
		JsonNode response = readResponse(body);
		if (response == null) {
			return BuildingLookupResult.notFound();
		}
		JsonNode features = features(response);

		Map<String, BuildingInfo> distinct = new LinkedHashMap<>();
		List<BuildingInfo> withoutId = new ArrayList<>();
		for (JsonNode feature : features) {
			BuildingInfo building = toBuilding(properties(feature));
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

	FeaturePage parseFeaturePage(String body, int requestedPage) {
		JsonNode response = readResponse(body);
		if (response == null) {
			// Real NOT_FOUND responses carry record.total "0" and no result.
			return new FeaturePage(0, 0, requestedPage, List.of());
		}
		JsonNode features = features(response);
		List<BuildingFeature> parsed = new ArrayList<>(features.size());
		for (JsonNode feature : features) {
			JsonNode geometry = feature.path("geometry");
			List<double[][][]> polygons = parseGeometry(geometry);
			if (polygons == null) {
				logger.warn("LT_C_SPBD feature without readable geometry ({})", geometryType(geometry));
			}
			parsed.add(new BuildingFeature(text(feature.path("id")), toBuilding(properties(feature)), polygons));
		}
		return new FeaturePage(intValue(response.path("record").path("total")),
				intValue(response.path("page").path("total")), intValue(response.path("page").path("current")),
				List.copyOf(parsed));
	}

	/**
	 * Reads a GeoJSON Polygon or MultiPolygon as {@code polygons[rings[points[lon, lat]]]}.
	 * Returns {@code null} instead of guessing when anything is missing or malformed. Open rings are closed.
	 */
	static List<double[][][]> parseGeometry(JsonNode geometry) {
		if (geometry == null || !geometry.isObject()) {
			return null;
		}
		String type = text(geometry.path("type"));
		JsonNode coordinates = geometry.path("coordinates");
		if (!coordinates.isArray() || coordinates.isEmpty()) {
			return null;
		}
		List<double[][][]> polygons = new ArrayList<>();
		if ("Polygon".equals(type)) {
			double[][][] polygon = parsePolygon(coordinates);
			if (polygon == null) {
				return null;
			}
			polygons.add(polygon);
		}
		else if ("MultiPolygon".equals(type)) {
			for (JsonNode polygonNode : coordinates) {
				double[][][] polygon = parsePolygon(polygonNode);
				if (polygon == null) {
					return null;
				}
				polygons.add(polygon);
			}
		}
		else {
			return null;
		}
		return List.copyOf(polygons);
	}

	private static double[][][] parsePolygon(JsonNode ringsNode) {
		if (!ringsNode.isArray() || ringsNode.isEmpty()) {
			return null;
		}
		double[][][] rings = new double[ringsNode.size()][][];
		for (int r = 0; r < ringsNode.size(); r++) {
			double[][] ring = parseRing(ringsNode.get(r));
			if (ring == null) {
				return null;
			}
			rings[r] = ring;
		}
		return rings;
	}

	private static double[][] parseRing(JsonNode ringNode) {
		if (!ringNode.isArray() || ringNode.size() < 3) {
			return null;
		}
		List<double[]> points = new ArrayList<>(ringNode.size() + 1);
		for (JsonNode position : ringNode) {
			if (!position.isArray() || position.size() < 2 || !position.get(0).isNumber()
					|| !position.get(1).isNumber()) {
				return null;
			}
			double lon = position.get(0).asDouble();
			double lat = position.get(1).asDouble();
			if (!Double.isFinite(lon) || !Double.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
				return null;
			}
			points.add(new double[] { lon, lat });
		}
		double[] first = points.get(0);
		double[] last = points.get(points.size() - 1);
		if (first[0] != last[0] || first[1] != last[1]) {
			points.add(new double[] { first[0], first[1] });
		}
		// A closed ring needs at least three distinct corners.
		if (points.size() < 4) {
			return null;
		}
		return points.toArray(new double[0][]);
	}

	private static String geometryType(JsonNode geometry) {
		String type = (geometry != null) ? text(geometry.path("type")) : null;
		return (type != null) ? type : "없음";
	}

	private static JsonNode properties(JsonNode feature) {
		JsonNode properties = feature.path("properties");
		if (!properties.isObject()) {
			throw unexpectedResponse("properties 없음");
		}
		return properties;
	}

	private static BuildingInfo toBuilding(JsonNode p) {
		return new BuildingInfo(text(p.path("bd_mgt_sn")), text(p.path("buld_nm")), text(p.path("buld_nm_dc")),
				text(p.path("gro_flo_co")), text(p.path("sido")), text(p.path("sigungu")), text(p.path("gu")),
				text(p.path("rd_nm")), text(p.path("buld_no")));
	}

	/** VWorld sends numbers in record/page as strings ("3420"). Returns -1 when missing or not a number. */
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
		logger.warn("Unexpected VWorld data API response: {}", detail);
		return new VWorldApiException(VWorldApiException.Reason.UNEXPECTED_RESPONSE, null,
				"VWorld 데이터 API 응답 형식을 확인할 수 없습니다.");
	}

}
