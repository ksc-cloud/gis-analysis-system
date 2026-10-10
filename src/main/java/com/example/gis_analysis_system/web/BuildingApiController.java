package com.example.gis_analysis_system.web;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisService;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.BuildingLookupResult;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;

/**
 * Building information for a clicked map position, looked up by coordinates (not by 3D model ID),
 * and buildings around a point (radius analysis).
 */
@RestController
@RequestMapping("/api/buildings")
public class BuildingApiController {

	// Approximate WGS84 bounds of South Korea including Jeju, Ulleungdo and Dokdo.
	static final double MIN_LON = 124.0;

	static final double MAX_LON = 132.0;

	static final double MIN_LAT = 33.0;

	static final double MAX_LAT = 39.0;

	private static final String RADIUS_PARAMETER = "radius";

	private final VWorldBuildingClient buildingClient;

	private final RadiusAnalysisService radiusAnalysisService;

	public BuildingApiController(VWorldBuildingClient buildingClient, RadiusAnalysisService radiusAnalysisService) {
		this.buildingClient = buildingClient;
		this.radiusAnalysisService = radiusAnalysisService;
	}

	@GetMapping("/at")
	public ResponseEntity<?> findAt(@RequestParam double lon, @RequestParam double lat) {
		if (!isValidCoordinate(lon, lat)) {
			return invalidCoordinate();
		}
		BuildingLookupResult result = this.buildingClient.findBuildingsAt(lon, lat);
		return ResponseEntity.ok(new BuildingLookupResponse(result.status(), lon, lat, result.totalCount(),
				result.buildings()));
	}

	/**
	 * Buildings whose footprint intersects the circle. A partial result (complete=false) is still 200;
	 * only a failure of the first VWorld page is an error response.
	 */
	@GetMapping("/nearby")
	public ResponseEntity<?> findNearby(@RequestParam double lon, @RequestParam double lat,
			@RequestParam(RADIUS_PARAMETER) String radius) {
		if (!isValidCoordinate(lon, lat)) {
			return invalidCoordinate();
		}
		Integer radiusMeters = parseRadius(radius);
		if (radiusMeters == null) {
			return invalidRadius();
		}
		RadiusAnalysisResult result = this.radiusAnalysisService.analyze(lon, lat, radiusMeters);
		return ResponseEntity.ok(result);
	}

	@ExceptionHandler(MissingServletRequestParameterException.class)
	ResponseEntity<ApiError> handleMissingParameter(MissingServletRequestParameterException ex) {
		return RADIUS_PARAMETER.equals(ex.getParameterName()) ? invalidRadius() : invalidCoordinate();
	}

	@ExceptionHandler(MethodArgumentTypeMismatchException.class)
	ResponseEntity<ApiError> handleBadParameter(MethodArgumentTypeMismatchException ex) {
		return RADIUS_PARAMETER.equals(ex.getName()) ? invalidRadius() : invalidCoordinate();
	}

	@ExceptionHandler(VWorldApiException.class)
	ResponseEntity<ApiError> handleVWorldError(VWorldApiException ex) {
		HttpStatus status = switch (ex.getReason()) {
			case API_KEY_MISSING -> HttpStatus.SERVICE_UNAVAILABLE;
			case TIMEOUT -> HttpStatus.GATEWAY_TIMEOUT;
			case API_ERROR, NETWORK_ERROR, UNEXPECTED_RESPONSE -> HttpStatus.BAD_GATEWAY;
		};
		return ResponseEntity.status(status)
			.body(new ApiError(ex.getReason().name(), ex.getMessage(), ex.getVworldErrorCode()));
	}

	private static boolean isValidCoordinate(double lon, double lat) {
		return lon >= MIN_LON && lon <= MAX_LON && lat >= MIN_LAT && lat <= MAX_LAT;
	}

	/** Whole meters only (no sign, decimals or exponent), within the supported range. */
	static Integer parseRadius(String value) {
		if (value == null || !value.trim().matches("\\d{1,4}")) {
			return null;
		}
		int radius = Integer.parseInt(value.trim());
		return (radius >= RadiusAnalysisService.MIN_RADIUS && radius <= RadiusAnalysisService.MAX_RADIUS) ? radius
				: null;
	}

	private static ResponseEntity<ApiError> invalidRadius() {
		return ResponseEntity.badRequest()
			.body(new ApiError("INVALID_RADIUS", "radius는 " + RadiusAnalysisService.MIN_RADIUS + "~"
					+ RadiusAnalysisService.MAX_RADIUS + " 사이의 정수(m)여야 합니다.", null));
	}

	private static ResponseEntity<ApiError> invalidCoordinate() {
		return ResponseEntity.badRequest()
			.body(new ApiError("INVALID_COORDINATE",
					"lon(" + MIN_LON + "~" + MAX_LON + "), lat(" + MIN_LAT + "~" + MAX_LAT + ") 범위의 숫자 좌표가 필요합니다.",
					null));
	}

	record BuildingLookupResponse(BuildingLookupResult.Status status, double lon, double lat, int totalCount,
			List<BuildingInfo> buildings) {
	}

	record ApiError(String error, String message, String vworldErrorCode) {
	}

}
