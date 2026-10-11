package com.example.gis_analysis_system.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.spatial.AnalysisServiceException;
import com.example.gis_analysis_system.spatial.InvalidSpatialRequestException;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.ServiceStatus;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.SpatialAnalysisResponse;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Spatial statistics from the Python analysis service, for saved analyses and unsaved snapshots.
 * <p>
 * Only these endpoints depend on Python. Its failures become {@code {"error", "message"}} answers here (503, 504,
 * 502, 413, 422) without Python's own messages, the token or any geometry; every other API is unaffected.
 * Snapshot tokens are never echoed in an answer or written to the log.
 */
@RestController
public class SpatialAnalysisController {

	private static final Logger logger = LoggerFactory.getLogger(SpatialAnalysisController.class);

	private final SpatialAnalysisService service;

	public SpatialAnalysisController(SpatialAnalysisService service) {
		this.service = service;
	}

	@GetMapping("/api/analyses/{id}/statistics")
	public SpatialAnalysisResponse savedStatistics(@PathVariable String id,
			@RequestParam(required = false) String includeBuildings) {
		return this.service.savedStatistics(parseId(id, "id"), parseBoolean(includeBuildings, false, "includeBuildings"));
	}

	@GetMapping("/api/analyses/{id}/grid-density")
	public SpatialAnalysisResponse savedGridDensity(@PathVariable String id,
			@RequestParam(required = false) String cellSize, @RequestParam(required = false) String includeEmptyCells,
			@RequestParam(required = false) String includeBuildingIds) {
		return this.service.savedGridDensity(parseId(id, "id"), parseCellSize(cellSize),
				parseBoolean(includeEmptyCells, true, "includeEmptyCells"),
				parseBoolean(includeBuildingIds, false, "includeBuildingIds"));
	}

	/** A blocked partial analysis is a 200 answer with result.status PARTIAL_RESULT_BLOCKED (decided by Python). */
	@GetMapping("/api/analyses/{id}/hotspot")
	public SpatialAnalysisResponse savedHotspot(@PathVariable String id, @RequestParam(required = false) String cellSize) {
		return this.service.savedHotspot(parseId(id, "id"), parseCellSize(cellSize));
	}

	@GetMapping("/api/analyses/{id}/comparison")
	public SpatialAnalysisResponse comparison(@PathVariable String id, @RequestParam(required = false) String with,
			@RequestParam(required = false) String includeUnchanged,
			@RequestParam(required = false) String includeBuildingChanges) {
		if (with == null) {
			throw new InvalidSpatialRequestException("INVALID_REQUEST", "비교할 분석 이력 ID(with)가 필요합니다.");
		}
		return this.service.comparison(parseId(id, "id"), parseId(with, "with"),
				parseBoolean(includeUnchanged, false, "includeUnchanged"),
				parseBoolean(includeBuildingChanges, true, "includeBuildingChanges"));
	}

	@GetMapping("/api/analysis-snapshots/{token}/statistics")
	public SpatialAnalysisResponse snapshotStatistics(@PathVariable String token,
			@RequestParam(required = false) String includeBuildings) {
		return this.service.snapshotStatistics(token, parseBoolean(includeBuildings, false, "includeBuildings"));
	}

	@GetMapping("/api/analysis-snapshots/{token}/grid-density")
	public SpatialAnalysisResponse snapshotGridDensity(@PathVariable String token,
			@RequestParam(required = false) String cellSize, @RequestParam(required = false) String includeEmptyCells,
			@RequestParam(required = false) String includeBuildingIds) {
		return this.service.snapshotGridDensity(token, parseCellSize(cellSize),
				parseBoolean(includeEmptyCells, true, "includeEmptyCells"),
				parseBoolean(includeBuildingIds, false, "includeBuildingIds"));
	}

	@GetMapping("/api/analysis-snapshots/{token}/hotspot")
	public SpatialAnalysisResponse snapshotHotspot(@PathVariable String token,
			@RequestParam(required = false) String cellSize) {
		return this.service.snapshotHotspot(token, parseCellSize(cellSize));
	}

	@GetMapping("/api/spatial-analysis/status")
	public ServiceStatus status() {
		return this.service.status();
	}

	// ----------------------------------------------------------------- error mapping

	@ExceptionHandler(AnalysisServiceException.class)
	ResponseEntity<SpatialApiError> handleAnalysisServiceError(AnalysisServiceException ex) {
		return ResponseEntity.status(ex.getReason().status())
			.body(new SpatialApiError(ex.getReason().name(), ex.getMessage(), ex.getServiceError()));
	}

	@ExceptionHandler(InvalidSpatialRequestException.class)
	ResponseEntity<SpatialApiError> handleInvalidRequest(InvalidSpatialRequestException ex) {
		return ResponseEntity.badRequest().body(new SpatialApiError(ex.getError(), ex.getMessage(), null));
	}

	/** The same statuses as AnalysisHistoryController for the codes these endpoints can meet. */
	@ExceptionHandler(AnalysisHistoryException.class)
	ResponseEntity<SpatialApiError> handleHistoryError(AnalysisHistoryException ex) {
		HttpStatus status = switch (ex.getCode()) {
			case INVALID_TOKEN, INVALID_TITLE, INVALID_PAGE, INVALID_SORT, INVALID_ID -> HttpStatus.BAD_REQUEST;
			case ANALYSIS_NOT_FOUND -> HttpStatus.NOT_FOUND;
			case ALREADY_SAVED, HISTORY_LIMIT -> HttpStatus.CONFLICT;
			case SNAPSHOT_EXPIRED -> HttpStatus.GONE;
			case UNSUPPORTED_RESULT -> HttpStatus.UNPROCESSABLE_CONTENT;
			case STORED_DATA_INVALID -> HttpStatus.INTERNAL_SERVER_ERROR;
		};
		if (status == HttpStatus.INTERNAL_SERVER_ERROR) {
			logger.error("Saved analysis could not be read: {}", ex.getMessage());
		}
		return ResponseEntity.status(status).body(new SpatialApiError(ex.getCode().name(), ex.getMessage(), null));
	}

	@ExceptionHandler({ DataAccessException.class, TransactionException.class })
	ResponseEntity<SpatialApiError> handleDatabaseError(RuntimeException ex) {
		if (AnalysisHistoryController.isDatabaseUnavailable(ex)) {
			logger.warn("Analysis history database unavailable for spatial analysis: {}", ex.getClass().getName());
			return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
				.body(new SpatialApiError("DB_UNAVAILABLE",
						"분석 이력 데이터베이스에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다.", null));
		}
		logger.error("Analysis history database error for spatial analysis: {}", ex.getClass().getName());
		return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
			.body(new SpatialApiError("DB_ERROR", "분석 이력을 처리하는 중 데이터베이스 오류가 발생했습니다.", null));
	}

	// ----------------------------------------------------------------- parameter parsing

	/** Same rule as AnalysisHistoryController: 1 to 18 digits, at least 1. */
	private static long parseId(String value, String name) {
		if (value == null || !value.matches("\\d{1,18}") || Long.parseLong(value) < 1) {
			throw new AnalysisHistoryException(AnalysisHistoryException.Code.INVALID_ID,
					"분석 이력 ID(" + name + ")는 1 이상의 정수여야 합니다.");
		}
		return Long.parseLong(value);
	}

	private static int parseCellSize(String value) {
		if (value == null) {
			return 100;
		}
		if (!value.matches("\\d{2,3}") || !SpatialAnalysisService.CELL_SIZES.contains(Integer.parseInt(value))) {
			throw new InvalidSpatialRequestException("INVALID_CELL_SIZE", "cellSize는 50, 100, 200 중 하나여야 합니다.");
		}
		return Integer.parseInt(value);
	}

	private static boolean parseBoolean(String value, boolean defaultValue, String name) {
		if (value == null) {
			return defaultValue;
		}
		return switch (value) {
			case "true" -> true;
			case "false" -> false;
			default -> throw new InvalidSpatialRequestException("INVALID_REQUEST", name + "는 true 또는 false여야 합니다.");
		};
	}

	/** @param analysisServiceError Python's error code (for example VALIDATION_ERROR) for 422, otherwise omitted */
	@JsonInclude(JsonInclude.Include.NON_NULL)
	record SpatialApiError(String error, String message, String analysisServiceError) {
	}

}
