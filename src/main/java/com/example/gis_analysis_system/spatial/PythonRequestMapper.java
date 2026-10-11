package com.example.gis_analysis_system.spatial;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import org.springframework.stereotype.Component;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;

import tools.jackson.databind.json.JsonMapper;

/**
 * Converts a radius analysis result into the Python request JSON. The reference mapping is
 * analysis-service/tests/java_result.py; PythonRequestMapperTests checks that both give the same JSON.
 * <p>
 * Values Python would reject are handled here: floor values and reason messages longer than Python accepts are
 * shortened (a shortened floor value stays invalid, so the floor statistics do not change), and a building id longer
 * than 80 characters stops the request before anything is sent.
 */
@Component
public class PythonRequestMapper {

	static final String SAVED = "SAVED";

	static final String LIVE = "LIVE";

	static final int MAX_ID_LENGTH = 80;

	static final int MAX_FLOOR_RAW_LENGTH = 20;

	static final int MAX_REASON_MESSAGE_LENGTH = 300;

	private final JsonMapper jsonMapper;

	public PythonRequestMapper(JsonMapper jsonMapper) {
		this.jsonMapper = jsonMapper;
	}

	/** Where an analysis comes from: a saved analysis (id set) or an unsaved snapshot (id null). */
	public record AnalysisSource(Long analysisId, Instant analyzedAt) {

		String kind() {
			return (this.analysisId != null) ? SAVED : LIVE;
		}

	}

	public byte[] buildingStats(RadiusAnalysisResult result, AnalysisSource source, boolean includeBuildings) {
		return write(new PythonRequests.BuildingStats(PythonRequests.SCHEMA_VERSION, source(source),
				center(result), result.radiusMeters(), result.complete(), reasons(result), result.summary(),
				includeBuildings, buildings(result)));
	}

	public byte[] gridDensity(RadiusAnalysisResult result, AnalysisSource source, int cellSizeMeters,
			boolean includeEmptyCells, boolean includeCellBuildingIds) {
		return write(new PythonRequests.GridDensity(PythonRequests.SCHEMA_VERSION, source(source), center(result),
				result.radiusMeters(), result.complete(), reasons(result), result.summary(), buildings(result),
				cellSizeMeters, includeEmptyCells, includeCellBuildingIds));
	}

	/** Both sides must be saved analyses; the caller has put them in analyzedAt order. */
	public byte[] compare(RadiusAnalysisResult before, AnalysisSource beforeSource, RadiusAnalysisResult after,
			AnalysisSource afterSource, boolean includeUnchanged, boolean includeBuildingChanges) {
		return write(new PythonRequests.Compare(PythonRequests.SCHEMA_VERSION, saved(before, beforeSource),
				saved(after, afterSource), includeUnchanged, includeBuildingChanges));
	}

	private PythonRequests.SavedAnalysis saved(RadiusAnalysisResult result, AnalysisSource source) {
		if (source.analysisId() == null) {
			throw new IllegalArgumentException("compare-analyses needs saved analyses");
		}
		RadiusAnalysisResult.DataSource data = result.source();
		return new PythonRequests.SavedAnalysis(PythonRequests.SCHEMA_VERSION, source(source), center(result),
				result.radiusMeters(), result.complete(), reasons(result), result.summary(), buildings(result),
				result.criterion(), (data != null)
						? new PythonRequests.DataSource(data.provider(), data.layer(), data.coordinateSystem(),
								data.notice())
						: null);
	}

	private static PythonRequests.Source source(AnalysisSource source) {
		// Instant.toString() is ISO-8601 in UTC with the "Z" suffix, which Python requires for comparisons.
		return new PythonRequests.Source(source.kind(), source.analysisId(),
				(source.analyzedAt() != null) ? source.analyzedAt().toString() : null);
	}

	private static PythonRequests.Center center(RadiusAnalysisResult result) {
		return new PythonRequests.Center(result.center().lon(), result.center().lat());
	}

	private static List<PythonRequests.IncompleteReason> reasons(RadiusAnalysisResult result) {
		return result.incompleteReasons()
			.stream()
			.map((reason) -> new PythonRequests.IncompleteReason(reason.code().name(),
					shorten(reason.message(), MAX_REASON_MESSAGE_LENGTH)))
			.toList();
	}

	private static List<PythonRequests.Building> buildings(RadiusAnalysisResult result) {
		List<PythonRequests.Building> buildings = new ArrayList<>(result.buildings().size());
		for (AnalyzedBuilding building : result.buildings()) {
			String id = building.id();
			if (id == null || id.isEmpty() || id.codePointCount(0, id.length()) > MAX_ID_LENGTH) {
				throw new AnalysisServiceException(Reason.ANALYSIS_DATA_UNSUPPORTED,
						"건물 식별자가 분석 서버가 처리할 수 있는 길이(" + MAX_ID_LENGTH + "자)를 넘습니다.");
			}
			String floors = (building.building() != null) ? building.building().groundFloorCount() : null;
			buildings.add(new PythonRequests.Building(id, shorten(floors, MAX_FLOOR_RAW_LENGTH),
					building.relation().name(), building.distanceMeters(),
					new PythonRequests.Geometry("MultiPolygon", building.polygons())));
		}
		return buildings;
	}

	/** First {@code max} code points (Python counts characters, not UTF-16 units). */
	static String shorten(String value, int max) {
		if (value == null || value.codePointCount(0, value.length()) <= max) {
			return value;
		}
		return value.substring(0, value.offsetByCodePoints(0, max));
	}

	private byte[] write(Object request) {
		return this.jsonMapper.writeValueAsBytes(request);
	}

}
