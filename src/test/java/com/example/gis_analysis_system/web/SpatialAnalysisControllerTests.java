package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.CannotCreateTransactionException;

import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.spatial.AnalysisServiceException;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;
import com.example.gis_analysis_system.spatial.InvalidSpatialRequestException;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.ServiceInfo;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.ServiceStatus;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.SpatialAnalysisResponse;

import tools.jackson.databind.json.JsonMapper;

@WebMvcTest(SpatialAnalysisController.class)
class SpatialAnalysisControllerTests {

	private static final String TOKEN = "0f8fad5b-d9cb-469f-a165-70867728950e";

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private SpatialAnalysisService service;

	private static SpatialAnalysisResponse response(Long... ids) {
		return new SpatialAnalysisResponse(List.of(ids), new ServiceInfo(1),
				JsonMapper.builder().build().readTree("{\"schemaVersion\":1,\"counts\":{\"analyzed\":3}}"));
	}

	// ----------------------------------------------------------------- routes

	@Test
	void savedStatisticsWithDefaults() throws Exception {
		given(this.service.savedStatistics(12, false)).willReturn(response(12L));

		this.mockMvc.perform(get("/api/analyses/12/statistics"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.analysisIds[0]").value(12))
			.andExpect(jsonPath("$.analysisService.schemaVersion").value(1))
			.andExpect(jsonPath("$.result.counts.analyzed").value(3));
	}

	@Test
	void savedGridDensityDefaultsAndOptions() throws Exception {
		given(this.service.savedGridDensity(anyLong(), anyInt(), anyBoolean(), anyBoolean())).willReturn(response(12L));

		this.mockMvc.perform(get("/api/analyses/12/grid-density")).andExpect(status().isOk());
		verify(this.service).savedGridDensity(12, 100, true, false);
		this.mockMvc
			.perform(get("/api/analyses/12/grid-density").param("cellSize", "50")
				.param("includeEmptyCells", "false")
				.param("includeBuildingIds", "true"))
			.andExpect(status().isOk());
		verify(this.service).savedGridDensity(12, 50, false, true);
	}

	@Test
	void comparison() throws Exception {
		given(this.service.comparison(12, 15, false, true)).willReturn(response(15L, 12L));

		this.mockMvc.perform(get("/api/analyses/12/comparison").param("with", "15"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.analysisIds[0]").value(15))
			.andExpect(jsonPath("$.analysisIds[1]").value(12));
	}

	@Test
	void comparisonOptions() throws Exception {
		given(this.service.comparison(12, 15, true, false)).willReturn(response(12L, 15L));

		this.mockMvc
			.perform(get("/api/analyses/12/comparison").param("with", "15")
				.param("includeUnchanged", "true")
				.param("includeBuildingChanges", "false"))
			.andExpect(status().isOk());
	}

	@Test
	void snapshotRoutes() throws Exception {
		given(this.service.snapshotStatistics(TOKEN, true)).willReturn(response());
		given(this.service.snapshotGridDensity(TOKEN, 200, true, false)).willReturn(response());

		this.mockMvc.perform(get("/api/analysis-snapshots/" + TOKEN + "/statistics").param("includeBuildings", "true"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.analysisIds").isEmpty());
		this.mockMvc.perform(get("/api/analysis-snapshots/" + TOKEN + "/grid-density").param("cellSize", "200"))
			.andExpect(status().isOk());
	}

	@Test
	void statusHasOnlyTwoFields() throws Exception {
		given(this.service.status()).willReturn(new ServiceStatus(false, true));

		MvcResult result = this.mockMvc.perform(get("/api/spatial-analysis/status"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.available").value(false))
			.andExpect(jsonPath("$.configured").value(true))
			.andReturn();
		assertThat(result.getResponse().getContentAsString()).isEqualTo("{\"available\":false,\"configured\":true}");
	}

	// ----------------------------------------------------------------- parameters

	@ParameterizedTest
	@ValueSource(strings = { "0", "-1", "abc", "1.5", "1234567890123456789" })
	void invalidIdsAreRejected(String id) throws Exception {
		this.mockMvc.perform(get("/api/analyses/" + id + "/statistics"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_ID"));
		this.mockMvc.perform(get("/api/analyses/12/comparison").param("with", id))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_ID"));
		verifyNoInteractions(this.service);
	}

	@ParameterizedTest
	@ValueSource(strings = { "75", "0", "1000", "abc", "100.0", "" })
	void invalidCellSizesAreRejected(String cellSize) throws Exception {
		this.mockMvc.perform(get("/api/analyses/12/grid-density").param("cellSize", cellSize))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_CELL_SIZE"));
		verifyNoInteractions(this.service);
	}

	@Test
	void invalidBooleansAndMissingWithAreRejected() throws Exception {
		this.mockMvc.perform(get("/api/analyses/12/statistics").param("includeBuildings", "yes"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_REQUEST"));
		this.mockMvc.perform(get("/api/analyses/12/comparison"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_REQUEST"));
		verifyNoInteractions(this.service);
	}

	@Test
	void sameAnalysisIsBadRequest() throws Exception {
		given(this.service.comparison(12, 12, false, true))
			.willThrow(new InvalidSpatialRequestException("SAME_ANALYSIS", "서로 다른 두 분석을 선택해야 합니다."));

		this.mockMvc.perform(get("/api/analyses/12/comparison").param("with", "12"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("SAME_ANALYSIS"));
	}

	// ----------------------------------------------------------------- errors

	@ParameterizedTest
	@EnumSource(Reason.class)
	void pythonFailuresHaveTheirStatus(Reason reason) throws Exception {
		given(this.service.savedStatistics(12, false))
			.willThrow(new AnalysisServiceException(reason, "분석 서버 오류", "VALIDATION_ERROR"));
		int expected = switch (reason) {
			case ANALYSIS_SERVICE_NOT_CONFIGURED, ANALYSIS_SERVICE_UNAVAILABLE, ANALYSIS_SERVICE_BUSY -> 503;
			case ANALYSIS_SERVICE_TIMEOUT -> 504;
			case ANALYSIS_SERVICE_AUTH_FAILED, ANALYSIS_SERVICE_ERROR, ANALYSIS_SERVICE_BAD_RESPONSE -> 502;
			case ANALYSIS_TOO_LARGE -> 413;
			case ANALYSIS_DATA_UNSUPPORTED -> 422;
		};

		this.mockMvc.perform(get("/api/analyses/12/statistics"))
			.andExpect(status().is(expected))
			.andExpect(jsonPath("$.error").value(reason.name()))
			.andExpect(jsonPath("$.message").value("분석 서버 오류"))
			.andExpect(jsonPath("$.analysisServiceError").value("VALIDATION_ERROR"));
	}

	@Test
	void serviceErrorCodeIsOmittedWhenAbsent() throws Exception {
		given(this.service.savedStatistics(12, false))
			.willThrow(new AnalysisServiceException(Reason.ANALYSIS_SERVICE_UNAVAILABLE, "연결할 수 없습니다."));

		MvcResult result = this.mockMvc.perform(get("/api/analyses/12/statistics"))
			.andExpect(status().isServiceUnavailable())
			.andReturn();
		assertThat(result.getResponse().getContentAsString()).doesNotContain("analysisServiceError");
	}

	@Test
	void historyErrors() throws Exception {
		given(this.service.savedStatistics(99, false))
			.willThrow(new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "분석 이력을 찾을 수 없습니다."));
		given(this.service.snapshotStatistics(TOKEN, false))
			.willThrow(new AnalysisHistoryException(Code.SNAPSHOT_EXPIRED, "분석 결과가 만료되었거나 없습니다."));
		given(this.service.snapshotStatistics("bad", false))
			.willThrow(new AnalysisHistoryException(Code.INVALID_TOKEN, "analysisToken이 올바르지 않습니다."));
		given(this.service.savedStatistics(98, false))
			.willThrow(new AnalysisHistoryException(Code.STORED_DATA_INVALID, "저장된 분석 결과를 읽을 수 없습니다."));

		this.mockMvc.perform(get("/api/analyses/99/statistics"))
			.andExpect(status().isNotFound())
			.andExpect(jsonPath("$.error").value("ANALYSIS_NOT_FOUND"));
		MvcResult expired = this.mockMvc.perform(get("/api/analysis-snapshots/" + TOKEN + "/statistics"))
			.andExpect(status().isGone())
			.andExpect(jsonPath("$.error").value("SNAPSHOT_EXPIRED"))
			.andReturn();
		assertThat(expired.getResponse().getContentAsString()).doesNotContain(TOKEN);
		this.mockMvc.perform(get("/api/analysis-snapshots/bad/statistics"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_TOKEN"));
		this.mockMvc.perform(get("/api/analyses/98/statistics"))
			.andExpect(status().isInternalServerError())
			.andExpect(jsonPath("$.error").value("STORED_DATA_INVALID"));
	}

	@Test
	void databaseDownIs503() throws Exception {
		given(this.service.savedStatistics(12, false))
			.willThrow(new CannotCreateTransactionException("no connection"));
		given(this.service.comparison(12, 15, false, true))
			.willThrow(new CannotGetJdbcConnectionException("no connection"));

		this.mockMvc.perform(get("/api/analyses/12/statistics"))
			.andExpect(status().isServiceUnavailable())
			.andExpect(jsonPath("$.error").value("DB_UNAVAILABLE"));
		this.mockMvc.perform(get("/api/analyses/12/comparison").param("with", "15"))
			.andExpect(status().isServiceUnavailable())
			.andExpect(jsonPath("$.error").value("DB_UNAVAILABLE"));
	}

	@Test
	void unexpectedTokenValuesAreNotEchoed() throws Exception {
		given(this.service.snapshotGridDensity(anyString(), anyInt(), anyBoolean(), anyBoolean()))
			.willThrow(new AnalysisHistoryException(Code.SNAPSHOT_EXPIRED, "분석 결과가 만료되었거나 없습니다."));

		MvcResult result = this.mockMvc.perform(get("/api/analysis-snapshots/" + TOKEN + "/grid-density"))
			.andExpect(status().isGone())
			.andReturn();
		assertThat(result.getResponse().getContentAsString()).doesNotContain(TOKEN);
	}

}
