package com.example.gis_analysis_system.spatial;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;

import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.history.AnalysisSnapshot;
import com.example.gis_analysis_system.history.AnalysisSnapshotStore;
import com.example.gis_analysis_system.spatial.AnalysisServiceClient.Endpoint;
import com.example.gis_analysis_system.spatial.PythonRequestMapper.AnalysisSource;

import tools.jackson.databind.JsonNode;

/**
 * Spatial statistics of saved analyses and of unsaved snapshots, computed by the Python service.
 * <p>
 * The browser sends only an analysis id or a snapshot token; the buildings are read from the history database or
 * the in-memory snapshot store and converted here. Python availability is checked before anything is loaded, and
 * every Python failure is an {@link AnalysisServiceException}, so the map, the radius analysis and the history keep
 * working whether or not Python runs.
 */
@Service
public class SpatialAnalysisService {

	public static final Set<Integer> CELL_SIZES = Set.of(50, 100, 200);

	private static final Pattern TOKEN = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
			+ "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

	private final AnalysisHistoryService historyService;

	private final AnalysisSnapshotStore snapshotStore;

	private final PythonRequestMapper mapper;

	private final AnalysisServiceClient client;

	public SpatialAnalysisService(AnalysisHistoryService historyService, AnalysisSnapshotStore snapshotStore,
			PythonRequestMapper mapper, AnalysisServiceClient client) {
		this.historyService = historyService;
		this.snapshotStore = snapshotStore;
		this.mapper = mapper;
		this.client = client;
	}

	/**
	 * What the browser receives: the analyses used (before, after for a comparison; empty for a snapshot), the
	 * Python response schema version and the validated Python response.
	 */
	public record SpatialAnalysisResponse(List<Long> analysisIds, ServiceInfo analysisService, JsonNode result) {
	}

	public record ServiceInfo(int schemaVersion) {
	}

	/** @param configured token and loopback URL are set; available: configured and Python /health answered ok */
	public record ServiceStatus(boolean available, boolean configured) {
	}

	public SpatialAnalysisResponse savedStatistics(long analysisId, boolean includeBuildings) {
		this.client.requireAvailable();
		AnalysisDetail detail = this.historyService.get(analysisId);
		byte[] body = this.mapper.buildingStats(detail.result(), saved(detail), includeBuildings);
		return response(List.of(detail.analysisId()), this.client.post(Endpoint.BUILDING_STATS, body));
	}

	public SpatialAnalysisResponse savedGridDensity(long analysisId, int cellSize, boolean includeEmptyCells,
			boolean includeBuildingIds) {
		requireCellSize(cellSize);
		this.client.requireAvailable();
		AnalysisDetail detail = this.historyService.get(analysisId);
		byte[] body = this.mapper.gridDensity(detail.result(), saved(detail), cellSize, includeEmptyCells,
				includeBuildingIds);
		return response(List.of(detail.analysisId()), this.client.post(Endpoint.GRID_DENSITY, body));
	}

	/**
	 * Grid hotspots of a saved analysis. A partial analysis is sent as well: Python is the only place that decides
	 * whether it is blocked (status PARTIAL_RESULT_BLOCKED), and its answer is returned as it is.
	 */
	public SpatialAnalysisResponse savedHotspot(long analysisId, int cellSize) {
		requireCellSize(cellSize);
		this.client.requireAvailable();
		AnalysisDetail detail = this.historyService.get(analysisId);
		byte[] body = this.mapper.hotspot(detail.result(), saved(detail), cellSize);
		return response(List.of(detail.analysisId()), this.client.post(Endpoint.HOTSPOT, body));
	}

	/**
	 * Compares two saved analyses. The older one (analyzedAt, then analysisId) is "before", whatever order the ids
	 * were given in.
	 */
	public SpatialAnalysisResponse comparison(long analysisId, long otherId, boolean includeUnchanged,
			boolean includeBuildingChanges) {
		if (analysisId == otherId) {
			throw new InvalidSpatialRequestException("SAME_ANALYSIS", "서로 다른 두 분석을 선택해야 합니다.");
		}
		this.client.requireAvailable();
		List<AnalysisDetail> ordered = List.of(this.historyService.get(analysisId), this.historyService.get(otherId))
			.stream()
			.sorted(Comparator.comparing(AnalysisDetail::analyzedAt).thenComparingLong(AnalysisDetail::analysisId))
			.toList();
		AnalysisDetail before = ordered.get(0);
		AnalysisDetail after = ordered.get(1);
		byte[] body = this.mapper.compare(before.result(), saved(before), after.result(), saved(after),
				includeUnchanged, includeBuildingChanges);
		return response(List.of(before.analysisId(), after.analysisId()), this.client.post(Endpoint.COMPARE, body));
	}

	public SpatialAnalysisResponse snapshotStatistics(String token, boolean includeBuildings) {
		AnalysisSnapshot snapshot = snapshot(token);
		byte[] body = this.mapper.buildingStats(snapshot.result(), live(snapshot), includeBuildings);
		return response(List.of(), this.client.post(Endpoint.BUILDING_STATS, body));
	}

	public SpatialAnalysisResponse snapshotGridDensity(String token, int cellSize, boolean includeEmptyCells,
			boolean includeBuildingIds) {
		requireCellSize(cellSize);
		AnalysisSnapshot snapshot = snapshot(token);
		byte[] body = this.mapper.gridDensity(snapshot.result(), live(snapshot), cellSize, includeEmptyCells,
				includeBuildingIds);
		return response(List.of(), this.client.post(Endpoint.GRID_DENSITY, body));
	}

	public SpatialAnalysisResponse snapshotHotspot(String token, int cellSize) {
		requireCellSize(cellSize);
		AnalysisSnapshot snapshot = snapshot(token);
		byte[] body = this.mapper.hotspot(snapshot.result(), live(snapshot), cellSize);
		return response(List.of(), this.client.post(Endpoint.HOTSPOT, body));
	}

	/** Never throws; the address and the token are not part of the answer. */
	public ServiceStatus status() {
		boolean configured = this.client.isConfigured();
		return new ServiceStatus(configured && this.client.isAvailable(), configured);
	}

	/**
	 * The same token rules and errors as saving (AnalysisHistoryService.save): a malformed token is INVALID_TOKEN,
	 * an unknown or expired one SNAPSHOT_EXPIRED. The token itself is never put in a message or a log.
	 */
	private AnalysisSnapshot snapshot(String token) {
		if (token == null || !TOKEN.matcher(token).matches()) {
			throw new AnalysisHistoryException(Code.INVALID_TOKEN, "analysisToken이 올바르지 않습니다. 반경 분석 응답의 값을 사용하세요.");
		}
		this.client.requireAvailable();
		return this.snapshotStore.find(UUID.fromString(token.toLowerCase(Locale.ROOT)))
			.orElseThrow(() -> new AnalysisHistoryException(Code.SNAPSHOT_EXPIRED,
					"분석 결과가 만료되었거나 없습니다. 반경 분석을 다시 실행하세요."));
	}

	private static void requireCellSize(int cellSize) {
		if (!CELL_SIZES.contains(cellSize)) {
			throw new InvalidSpatialRequestException("INVALID_CELL_SIZE", "cellSize는 50, 100, 200 중 하나여야 합니다.");
		}
	}

	private static AnalysisSource saved(AnalysisDetail detail) {
		return new AnalysisSource(detail.analysisId(), detail.analyzedAt());
	}

	private static AnalysisSource live(AnalysisSnapshot snapshot) {
		return new AnalysisSource(null, snapshot.analyzedAt());
	}

	private static SpatialAnalysisResponse response(List<Long> analysisIds, JsonNode result) {
		return new SpatialAnalysisResponse(analysisIds, new ServiceInfo(result.get("schemaVersion").asInt()), result);
	}

}
