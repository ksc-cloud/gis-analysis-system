package com.example.gis_analysis_system.web;

import static org.mockito.ArgumentMatchers.anyDouble;
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

	private void expectFailure(VWorldApiException exception, int httpStatus, String error) throws Exception {
		// willThrow().given() does not call the previously stubbed (throwing) method while re-stubbing.
		willThrow(exception).given(this.buildingClient).findBuildingsAt(126.978, 37.5665);
		this.mockMvc.perform(get("/api/buildings/at").param("lon", "126.978").param("lat", "37.5665"))
			.andExpect(status().is(httpStatus))
			.andExpect(jsonPath("$.error").value(error));
	}

}
