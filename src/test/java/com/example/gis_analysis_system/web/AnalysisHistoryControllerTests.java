package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.BDDMockito.willThrow;
import static org.mockito.Mockito.never;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.SQLTransientConnectionException;
import java.time.Instant;
import java.util.List;

import org.apache.ibatis.exceptions.PersistenceException;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.MyBatisSystemException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.CannotCreateTransactionException;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Center;
import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService;
import com.example.gis_analysis_system.history.AnalysisHistoryService.HistoryItem;
import com.example.gis_analysis_system.history.AnalysisHistoryService.HistoryPage;
import com.example.gis_analysis_system.history.AnalysisHistoryService.SavedAnalysis;
import com.example.gis_analysis_system.history.HistorySort;

@WebMvcTest(AnalysisHistoryController.class)
class AnalysisHistoryControllerTests {

	private static final String TOKEN = "0f8fad5b-d9cb-469f-a165-70867728950e";

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private AnalysisHistoryService historyService;

	@Test
	void saveReturnsCreatedWithLocation() throws Exception {
		given(this.historyService.save(TOKEN, "서울시청 반경"))
			.willReturn(new SavedAnalysis(7, "서울시청 반경", Instant.parse("2026-10-11T03:00:05.123Z"), 42));

		postJson("{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"서울시청 반경\"}").andExpect(status().isCreated())
			.andExpect(header().string("Location", "/api/analyses/7"))
			.andExpect(jsonPath("$.analysisId").value(7))
			.andExpect(jsonPath("$.title").value("서울시청 반경"))
			.andExpect(jsonPath("$.savedAt").value("2026-10-11T03:00:05.123Z"))
			.andExpect(jsonPath("$.buildingCount").value(42));
	}

	@Test
	void saveRejectsMalformedBodiesWithoutCallingTheService() throws Exception {
		String[][] cases = { { "{", "INVALID_REQUEST" }, { "", "INVALID_REQUEST" }, { "[]", "INVALID_REQUEST" },
				{ "\"text\"", "INVALID_REQUEST" }, { "null", "INVALID_REQUEST" },
				{ "{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"t\",\"buildings\":[]}", "INVALID_REQUEST" },
				{ "{\"analysisToken\":123,\"title\":\"t\"}", "INVALID_TOKEN" },
				{ "{\"analysisToken\":\"" + TOKEN + "\",\"title\":{\"x\":1}}", "INVALID_TITLE" } };
		for (String[] c : cases) {
			var response = postJson(c[0]).andReturn().getResponse();
			assertThat(response.getStatus()).as(c[0]).isEqualTo(400);
			assertThat(response.getContentAsString()).as(c[0]).contains("\"error\":\"" + c[1] + "\"");
		}
		this.mockMvc
			.perform(post("/api/analyses").contentType(MediaType.TEXT_PLAIN).content("analysisToken=" + TOKEN))
			.andExpect(status().isUnsupportedMediaType())
			.andExpect(jsonPath("$.error").value("UNSUPPORTED_MEDIA_TYPE"));
		this.mockMvc
			.perform(post("/api/analyses").contentType(MediaType.APPLICATION_FORM_URLENCODED)
				.content("analysisToken=" + TOKEN))
			.andExpect(status().isUnsupportedMediaType());
		then(this.historyService).should(never()).save(any(), any());
	}

	@Test
	void missingFieldsAreLeftToTheServiceValidation() throws Exception {
		given(this.historyService.save(null, null))
			.willThrow(new AnalysisHistoryException(Code.INVALID_TOKEN, "analysisToken이 올바르지 않습니다."));

		postJson("{}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("INVALID_TOKEN"));
	}

	@Test
	void oversizedBodyIsRejectedBeforeParsing() throws Exception {
		String title = "가".repeat(AnalysisRequestSizeFilter.MAX_BODY_BYTES);

		postJson("{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"" + title + "\"}")
			.andExpect(status().isContentTooLarge())
			.andExpect(jsonPath("$.error").value("PAYLOAD_TOO_LARGE"));
		then(this.historyService).should(never()).save(any(), any());
	}

	@Test
	void mapsServiceErrorsToStatusCodes() throws Exception {
		Object[][] cases = { { Code.INVALID_TOKEN, 400 }, { Code.INVALID_TITLE, 400 },
				{ Code.SNAPSHOT_EXPIRED, 410 }, { Code.HISTORY_LIMIT, 409 }, { Code.UNSUPPORTED_RESULT, 422 } };
		for (Object[] c : cases) {
			Code code = (Code) c[0];
			willThrow(new AnalysisHistoryException(code, "메시지 " + code)).given(this.historyService)
				.save(anyString(), anyString());
			postJson("{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"t\"}").andExpect(status().is((int) c[1]))
				.andExpect(jsonPath("$.error").value(code.name()))
				.andExpect(jsonPath("$.message").value("메시지 " + code))
				.andExpect(jsonPath("$.analysisId").doesNotExist());
		}
		willThrow(new AnalysisHistoryException(Code.ALREADY_SAVED, "이미 저장", 9L)).given(this.historyService)
			.save(anyString(), anyString());
		postJson("{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"t\"}").andExpect(status().isConflict())
			.andExpect(jsonPath("$.error").value("ALREADY_SAVED"))
			.andExpect(jsonPath("$.analysisId").value(9));
	}

	@Test
	void listUsesDefaultsAndReturnsThePage() throws Exception {
		HistoryItem item = new HistoryItem(3, "이력", 500, new Center(126.978, 37.5665), 12, true,
				Instant.parse("2026-10-11T02:59:59Z"), Instant.parse("2026-10-11T03:00:00Z"));
		given(this.historyService.list(1, 20, HistorySort.SAVED_DESC))
			.willReturn(new HistoryPage(List.of(item), 1, 20, 1, 1, 500));

		this.mockMvc.perform(get("/api/analyses"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.items[0].analysisId").value(3))
			.andExpect(jsonPath("$.items[0].radiusMeters").value(500))
			.andExpect(jsonPath("$.items[0].center.lon").value(126.978))
			.andExpect(jsonPath("$.items[0].buildingCount").value(12))
			.andExpect(jsonPath("$.items[0].savedAt").value("2026-10-11T03:00:00Z"))
			.andExpect(jsonPath("$.totalItems").value(1))
			.andExpect(jsonPath("$.maxHistory").value(500));
	}

	@Test
	void listRejectsInvalidPagingAndSortWithoutTouchingTheDatabase() throws Exception {
		for (String page : new String[] { "abc", "-1", "1.5", "1e3", "", "9999999" }) {
			this.mockMvc.perform(get("/api/analyses").param("page", page))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_PAGE"));
		}
		for (String sort : new String[] { "saved_desc", "SAVED_DESC; DROP TABLE gis_analysis_history",
				"title DESC", "(SELECT 1)", "" }) {
			this.mockMvc.perform(get("/api/analyses").param("sort", sort))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_SORT"));
		}
		then(this.historyService).should(never()).list(anyInt(), anyInt(), any());
	}

	@Test
	void listPassesTheAllowedSorts() throws Exception {
		given(this.historyService.list(anyInt(), anyInt(), any())).willReturn(new HistoryPage(List.of(), 2, 5, 0, 0, 500));
		for (HistorySort sort : HistorySort.values()) {
			this.mockMvc.perform(get("/api/analyses").param("page", "2").param("size", "5").param("sort", sort.name()))
				.andExpect(status().isOk());
			then(this.historyService).should().list(2, 5, sort);
		}
	}

	@Test
	void detailAndDeleteValidateTheId() throws Exception {
		for (String id : new String[] { "abc", "-1", "1.0", "1e3", "1%27%20OR%201=1", "9999999999999999999" }) {
			this.mockMvc.perform(get("/api/analyses/" + id))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_ID"));
			this.mockMvc.perform(delete("/api/analyses/" + id))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_ID"));
		}
		then(this.historyService).should(never()).get(anyLong());
		then(this.historyService).should(never()).delete(anyLong());
	}

	/** Servlet path parameters (";...") are dropped by Spring before matching; only the number reaches the service. */
	@Test
	void pathParametersAfterTheIdAreIgnored() throws Exception {
		this.mockMvc.perform(delete("/api/analyses/5;DROP TABLE gis_analysis_history")).andExpect(status().isNoContent());
		then(this.historyService).should().delete(5);
	}

	@Test
	void detailAndDeleteMapNotFound() throws Exception {
		given(this.historyService.get(404)).willThrow(new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "없음"));
		willThrow(new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "없음")).given(this.historyService).delete(404);

		this.mockMvc.perform(get("/api/analyses/404"))
			.andExpect(status().isNotFound())
			.andExpect(jsonPath("$.error").value("ANALYSIS_NOT_FOUND"));
		this.mockMvc.perform(delete("/api/analyses/404"))
			.andExpect(status().isNotFound())
			.andExpect(jsonPath("$.error").value("ANALYSIS_NOT_FOUND"));
	}

	@Test
	void deleteReturnsNoContent() throws Exception {
		this.mockMvc.perform(delete("/api/analyses/5")).andExpect(status().isNoContent());
		then(this.historyService).should().delete(5);
	}

	@Test
	void databaseConnectionProblemsAre503() throws Exception {
		RuntimeException[] unavailable = { new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection"),
				new MyBatisSystemException(new PersistenceException(
						new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection"))),
				new CannotCreateTransactionException("Could not open JDBC Connection for transaction"),
				new org.springframework.dao.TransientDataAccessResourceException("pool",
						new SQLTransientConnectionException("gis-db - Connection is not available")) };
		for (RuntimeException ex : unavailable) {
			willThrow(ex).given(this.historyService).list(anyInt(), anyInt(), any());
			this.mockMvc.perform(get("/api/analyses"))
				.andExpect(status().isServiceUnavailable())
				.andExpect(jsonPath("$.error").value("DB_UNAVAILABLE"));
		}
		willThrow(new CannotGetJdbcConnectionException("down")).given(this.historyService).delete(1);
		this.mockMvc.perform(delete("/api/analyses/1")).andExpect(status().isServiceUnavailable());
	}

	@Test
	void otherDatabaseErrorsAre500WithoutDetails() throws Exception {
		willThrow(new DataIntegrityViolationException(
				"### SQL: INSERT INTO gis_analysis_history ... password=secret CONSTRAINT ck_history_counts"))
			.given(this.historyService)
			.save(anyString(), anyString());

		String body = postJson("{\"analysisToken\":\"" + TOKEN + "\",\"title\":\"t\"}")
			.andExpect(status().isInternalServerError())
			.andExpect(jsonPath("$.error").value("DB_ERROR"))
			.andReturn()
			.getResponse()
			.getContentAsString();
		assertThat(body).doesNotContain("SQL").doesNotContain("secret").doesNotContain("ck_history");
	}

	@Test
	void storedDataProblemsAre500() throws Exception {
		given(this.historyService.get(3))
			.willThrow(new AnalysisHistoryException(Code.STORED_DATA_INVALID, "저장된 분석 결과를 읽을 수 없습니다."));

		this.mockMvc.perform(get("/api/analyses/3"))
			.andExpect(status().isInternalServerError())
			.andExpect(jsonPath("$.error").value("STORED_DATA_INVALID"));
	}

	private ResultActions postJson(String json) throws Exception {
		return this.mockMvc.perform(post("/api/analyses").contentType(MediaType.APPLICATION_JSON).content(json));
	}

}
