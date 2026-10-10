package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.BDDMockito.willThrow;
import static org.mockito.Mockito.never;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisService;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.BuildingLookupResult;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;

@WebMvcTest(BuildingApiController.class)
class BuildingApiControllerTests {

	private static final BuildingInfo CITY_HALL = new BuildingInfo("1114010300100310000000001", "서울특별시청", null,
			"13", "서울특별시", "중구", null, "세종대로", "110");

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private VWorldBuildingClient buildingClient;

	@MockitoBean
	private RadiusAnalysisService radiusAnalysisService;

	@Test
	void returnsFoundBuilding() throws Exception {
		given(this.buildingClient.findBuildingsAt(126.978, 37.5665))
			.willReturn(new BuildingLookupResult(BuildingLookupResult.Status.FOUND, 1, List.of(CITY_HALL)));

		this.mockMvc.perform(get("/api/buildings/at").param("lon", "126.978").param("lat", "37.5665"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("FOUND"))
			.andExpect(jsonPath("$.lon").value(126.978))
			.andExpect(jsonPath("$.lat").value(37.5665))
			.andExpect(jsonPath("$.buildings[0].buildingName").value("서울특별시청"))
			.andExpect(jsonPath("$.buildings[0].buildingManagementNumber").value("1114010300100310000000001"))
			.andExpect(jsonPath("$.buildings[0].groundFloorCount").value("13"));
	}

	@Test
	void returnsNotFoundAndAmbiguousAsOk() throws Exception {
		given(this.buildingClient.findBuildingsAt(127.0, 37.0)).willReturn(BuildingLookupResult.notFound());
		given(this.buildingClient.findBuildingsAt(127.1, 37.1))
			.willReturn(new BuildingLookupResult(BuildingLookupResult.Status.AMBIGUOUS, 2, List.of(CITY_HALL, CITY_HALL)));

		this.mockMvc.perform(get("/api/buildings/at").param("lon", "127.0").param("lat", "37.0"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("NOT_FOUND"))
			.andExpect(jsonPath("$.buildings").isEmpty());
		this.mockMvc.perform(get("/api/buildings/at").param("lon", "127.1").param("lat", "37.1"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("AMBIGUOUS"))
			.andExpect(jsonPath("$.totalCount").value(2));
	}

	@Test
	void rejectsInvalidCoordinatesWithoutCallingVWorld() throws Exception {
		String[][] invalid = { { "200", "37.5" }, { "126.9", "10" }, { "abc", "37.5" }, { "NaN", "37.5" },
				{ "126.9", "" } };
		for (String[] params : invalid) {
			this.mockMvc.perform(get("/api/buildings/at").param("lon", params[0]).param("lat", params[1]))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_COORDINATE"));
		}
		this.mockMvc.perform(get("/api/buildings/at").param("lon", "126.9"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_COORDINATE"));

		then(this.buildingClient).should(never()).findBuildingsAt(anyDouble(), anyDouble());
	}

	@Test
	void mapsVWorldFailuresToStatusCodes() throws Exception {
		expectFailure(new VWorldApiException(VWorldApiException.Reason.API_KEY_MISSING, null, "키 없음"), 503,
				"API_KEY_MISSING");
		expectFailure(new VWorldApiException(VWorldApiException.Reason.TIMEOUT, null, "시간 초과"), 504, "TIMEOUT");
		expectFailure(new VWorldApiException(VWorldApiException.Reason.NETWORK_ERROR, null, "연결 실패"), 502,
				"NETWORK_ERROR");
		expectFailure(new VWorldApiException(VWorldApiException.Reason.UNEXPECTED_RESPONSE, null, "형식 오류"), 502,
				"UNEXPECTED_RESPONSE");

		willThrow(new VWorldApiException(VWorldApiException.Reason.API_ERROR, "INVALID_KEY", "등록되지 않은 인증키입니다."))
			.given(this.buildingClient)
			.findBuildingsAt(126.978, 37.5665);
		this.mockMvc.perform(get("/api/buildings/at").param("lon", "126.978").param("lat", "37.5665"))
			.andExpect(status().isBadGateway())
			.andExpect(jsonPath("$.error").value("API_ERROR"))
			.andExpect(jsonPath("$.vworldErrorCode").value("INVALID_KEY"))
			.andExpect(jsonPath("$.message").value("등록되지 않은 인증키입니다."));
	}

	@Test
	void nearbyReturnsTheAnalysis() throws Exception {
		RadiusAnalysisResult analysis = sampleAnalysis(true);
		given(this.radiusAnalysisService.analyze(126.978, 37.5665, 500)).willReturn(analysis);

		this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665")
			.param("radius", "500"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.center.lon").value(126.978))
			.andExpect(jsonPath("$.radiusMeters").value(500))
			.andExpect(jsonPath("$.criterion").value("POLYGON_INTERSECTS_CIRCLE"))
			.andExpect(jsonPath("$.complete").value(true))
			.andExpect(jsonPath("$.reportedTotal").value(1))
			.andExpect(jsonPath("$.summary.inside").value(1))
			.andExpect(jsonPath("$.buildings[0].relation").value("INSIDE"))
			.andExpect(jsonPath("$.buildings[0].building.buildingManagementNumber").value("1114010300100310000000001"))
			.andExpect(jsonPath("$.buildings[0].polygons[0][0][0][0]").isNumber())
			.andExpect(jsonPath("$.floorStatistics.withData").value(1))
			.andExpect(jsonPath("$.source.layer").value("LT_C_SPBD (도로명주소 건물)"));
	}

	@Test
	void nearbyPartialResultIsOkWithReasons() throws Exception {
		RadiusAnalysisResult analysis = sampleAnalysis(false);
		given(this.radiusAnalysisService.analyze(126.978, 37.5665, 1000)).willReturn(analysis);

		this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665")
			.param("radius", "1000"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.complete").value(false))
			.andExpect(jsonPath("$.incompleteReasons[0].code").value("PAGE_LIMIT"));
	}

	@Test
	void nearbyRejectsInvalidRadiusWithoutCallingVWorld() throws Exception {
		for (String radius : new String[] { "49", "1001", "0", "-100", "100.5", "1e3", "abc", "", " " }) {
			this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665")
				.param("radius", radius))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_RADIUS"));
		}
		this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_RADIUS"));

		then(this.radiusAnalysisService).should(never()).analyze(anyDouble(), anyDouble(), anyInt());
	}

	@Test
	void nearbyAcceptsTheBoundaryRadii() throws Exception {
		RadiusAnalysisResult analysis = sampleAnalysis(true);
		given(this.radiusAnalysisService.analyze(anyDouble(), anyDouble(), anyInt())).willReturn(analysis);

		for (String radius : new String[] { "50", "100", "1000" }) {
			this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665")
				.param("radius", radius))
				.andExpect(status().isOk());
		}
	}

	@Test
	void nearbyRejectsInvalidCoordinates() throws Exception {
		String[][] invalid = { { "200", "37.5" }, { "126.9", "10" }, { "abc", "37.5" }, { "NaN", "37.5" } };
		for (String[] params : invalid) {
			this.mockMvc.perform(get("/api/buildings/nearby").param("lon", params[0]).param("lat", params[1])
				.param("radius", "100"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("INVALID_COORDINATE"));
		}
		this.mockMvc.perform(get("/api/buildings/nearby").param("lat", "37.5").param("radius", "100"))
			.andExpect(status().isBadRequest())
			.andExpect(jsonPath("$.error").value("INVALID_COORDINATE"));

		then(this.radiusAnalysisService).should(never()).analyze(anyDouble(), anyDouble(), anyInt());
	}

	@Test
	void nearbyMapsVWorldFailuresToStatusCodes() throws Exception {
		Object[][] cases = { { VWorldApiException.Reason.API_KEY_MISSING, 503 },
				{ VWorldApiException.Reason.TIMEOUT, 504 }, { VWorldApiException.Reason.API_ERROR, 502 },
				{ VWorldApiException.Reason.NETWORK_ERROR, 502 },
				{ VWorldApiException.Reason.UNEXPECTED_RESPONSE, 502 } };
		for (Object[] c : cases) {
			VWorldApiException.Reason reason = (VWorldApiException.Reason) c[0];
			willThrow(new VWorldApiException(reason, null, "실패")).given(this.radiusAnalysisService)
				.analyze(126.978, 37.5665, 100);
			this.mockMvc.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665")
				.param("radius", "100"))
				.andExpect(status().is((int) c[1]))
				.andExpect(jsonPath("$.error").value(reason.name()));
		}
	}

	@Test
	void nearbyResponseNeverContainsTheKey() throws Exception {
		RadiusAnalysisResult analysis = sampleAnalysis(true);
		given(this.radiusAnalysisService.analyze(126.978, 37.5665, 500)).willReturn(analysis);

		String body = this.mockMvc
			.perform(get("/api/buildings/nearby").param("lon", "126.978").param("lat", "37.5665").param("radius", "500"))
			.andReturn()
			.getResponse()
			.getContentAsString();

		assertThat(body).doesNotContain("key=").doesNotContain("api.vworld.kr");
	}

	/** Built with the real service and a mocked client, so the JSON shape is the production one. */
	private static RadiusAnalysisResult sampleAnalysis(boolean complete) {
		VWorldBuildingClient client = mock(VWorldBuildingClient.class);
		double d = 0.0001;
		double[][][] polygon = { { { 126.978 - d, 37.5665 - d }, { 126.978 + d, 37.5665 - d },
				{ 126.978 + d, 37.5665 + d }, { 126.978 - d, 37.5665 - d } } };
		BuildingFeature feature = new BuildingFeature("LT_C_SPBD.1", CITY_HALL, List.<double[][][]>of(polygon));
		int pages = complete ? 1 : 7;
		for (int page = 1; page <= 5; page++) {
			given(client.findBuildingsWithin(anyDouble(), anyDouble(), anyInt(), org.mockito.ArgumentMatchers.eq(page)))
				.willReturn(new VWorldBuildingClient.FeaturePage(complete ? 1 : 7000, pages, page, List.of(feature)));
		}
		return new RadiusAnalysisService(client).analyze(126.978, 37.5665, complete ? 500 : 1000);
	}

	private void expectFailure(VWorldApiException exception, int httpStatus, String error) throws Exception {
		// willThrow().given() does not call the previously stubbed (throwing) method while re-stubbing.
		willThrow(exception).given(this.buildingClient).findBuildingsAt(126.978, 37.5665);
		this.mockMvc.perform(get("/api/buildings/at").param("lon", "126.978").param("lat", "37.5665"))
			.andExpect(status().is(httpStatus))
			.andExpect(jsonPath("$.error").value(error));
	}

}
