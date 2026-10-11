package com.example.gis_analysis_system.history;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * SQL for the analysis history tables (resources/mapper/AnalysisHistoryMapper.xml). Every value is bound with
 * {@code #{}}; the list order comes from {@link HistorySort} through fixed ORDER BY clauses.
 */
@Mapper
public interface AnalysisHistoryMapper {

	Long findIdByToken(@Param("snapshotToken") String snapshotToken);

	long countHistory();

	void insertHistory(HistoryInsert insert);

	void insertReasons(@Param("reasons") List<ReasonRow> reasons);

	void insertBuildings(@Param("buildings") List<BuildingRow> buildings);

	List<HistorySummaryRow> findPage(@Param("sort") HistorySort sort, @Param("limit") int limit,
			@Param("offset") long offset);

	HistoryRow findHistory(@Param("analysisId") long analysisId);

	List<ReasonRow> findReasons(@Param("analysisId") long analysisId);

	List<BuildingRow> findBuildings(@Param("analysisId") long analysisId);

	FloorStatsRow findFloorStats(@Param("analysisId") long analysisId);

	/** Reasons and buildings go with it (ON DELETE CASCADE). */
	int deleteHistory(@Param("analysisId") long analysisId);

}
