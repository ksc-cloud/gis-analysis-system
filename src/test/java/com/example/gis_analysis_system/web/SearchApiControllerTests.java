package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
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

import com.example.gis_analysis_system.vworld.SearchResult;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldSearchClient;
import com.example.gis_analysis_system.vworld.VWorldSearchClient.SearchType;

@WebMvcTest(SearchApiController.class)
class SearchApiControllerTests {

	private static final SearchResult.Item CITY_HALL = new SearchResult.Item("POI01000000M8XJGM", "서울특별시청",
			"서울특별시 중구 세종대로 110", "지방행정기관 > 특별/광역시청", "서울특별시 중구 세종대로 110", "서울특별시 중구 태평로1가 31",
			126.9783882002353, 37.56661030125725);

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private VWorldSearchClient searchClient;

	@Test
	void returnsResults() throws Exception {
		given(this.searchClient.search("서울특별시청", SearchType.PLACE, 1))
			.willReturn(new SearchResult(true, 34, 4, 1, List.of(CITY_HALL), 0));

		this.mockMvc.perform(get("/api/search").param("query", "  서울특별시청  ").param("type", "place"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("FOUND"))
			.andExpect(jsonPath("$.query").value("서울특별시청"))
			.andExpect(jsonPath("$.type").value("place"))
			.andExpect(jsonPath("$.page").value(1))
			.andExpect(jsonPath("$.totalPages").value(4))
			.andExpect(jsonPath("$.totalCount").value(34))
			.andExpect(jsonPath("$.pageSize").value(10))
			.andExpect(jsonPath("$.items[0].title").value("서울특별시청"))
			.andExpect(jsonPath("$.items[0].subtitle").value("서울특별시 중구 세종대로 110"))
			.andExpect(jsonPath("$.items[0].lon").value(126.9783882002353))
			.andExpect(jsonPath("$.items[0].lat").value(37.56661030125725));
	}

	@Test
	void typeAndPageAreForwarded() throws Exception {
		given(this.searchClient.search(anyString(), any(), anyInt())).willReturn(SearchResult.notFound(1));

		this.mockMvc.perform(get("/api/search").param("query", "세종대로 110").param("type", "road").param("page", "3"))
			.andExpect(status().isOk());
		this.mockMvc.perform(get("/api/search").param("query", "태평로1가 31").param("type", "parcel"))
			.andExpect(status().isOk());
		this.mockMvc.perform(get("/api/search").param("query", "서울시청")).andExpect(status().isOk());

		then(this.searchClient).should().search("세종대로 110", SearchType.ROAD, 3);
		then(this.searchClient).should().search("태평로1가 31", SearchType.PARCEL, 1);
		then(this.searchClient).should().search("서울시청", SearchType.PLACE, 1);
	}

	@Test
	void notFoundIs200WithEmptyItems() throws Exception {
		given(this.searchClient.search("없는장소", SearchType.PLACE, 1)).willReturn(SearchResult.notFound(1));

		this.mockMvc.perform(get("/api/search").param("query", "없는장소").param("type", "place"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("NOT_FOUND"))
			.andExpect(jsonPath("$.items").isEmpty())
			.andExpect(jsonPath("$.totalCount").value(0));
	}

	@Test
	void resultsWithOnlyInvalidCoordinatesAreNotFound() throws Exception {
		given(this.searchClient.search("범위밖", SearchType.PLACE, 1)).willReturn(new SearchResult(true, 3, 1, 1, List.of(), 3));

		this.mockMvc.perform(get("/api/search").param("query", "범위밖"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.status").value("NOT_FOUND"));
	}

	@Test
	void rejectsInvalidInputWithoutCallingVWorld() throws Exception {
		String[][] invalid = { { null, "place", "1", "INVALID_QUERY" }, { "", "place", "1", "INVALID_QUERY" },
				{ "   ", "place", "1", "INVALID_QUERY" }, { "가", "place", "1", "INVALID_QUERY" },
				{ "가".repeat(101), "place", "1", "INVALID_QUERY" }, { "줄\n바꿈", "place", "1", "INVALID_QUERY" },
				{ "서울", "address", "1", "INVALID_TYPE" }, { "서울", "PLACE", "1", "INVALID_TYPE" },
				{ "서울", "district", "1", "INVALID_TYPE" }, { "서울", "place", "0", "INVALID_PAGE" },
				{ "서울", "place", "101", "INVALID_PAGE" }, { "서울", "place", "-1", "INVALID_PAGE" },
				{ "서울", "place", "1.5", "INVALID_PAGE" }, { "서울", "place", "abc", "INVALID_PAGE" } };
		for (String[] c : invalid) {
			var request = get("/api/search").param("type", c[1]).param("page", c[2]);
			if (c[0] != null) {
				request = request.param("query", c[0]);
			}
			this.mockMvc.perform(request).andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value(c[3]));
		}
		then(this.searchClient).should(never()).search(anyString(), any(), anyInt());
	}

	@Test
	void acceptsBoundaryLengths() throws Exception {
		given(this.searchClient.search(anyString(), any(), anyInt())).willReturn(SearchResult.notFound(1));

		this.mockMvc.perform(get("/api/search").param("query", "서울")).andExpect(status().isOk());
		this.mockMvc.perform(get("/api/search").param("query", "가".repeat(100))).andExpect(status().isOk());
		this.mockMvc.perform(get("/api/search").param("query", "🏢".repeat(100))).andExpect(status().isOk());
		this.mockMvc.perform(get("/api/search").param("query", "서울").param("page", "100")).andExpect(status().isOk());
	}

	@Test
	void mapsVWorldFailuresToStatusCodes() throws Exception {
		Object[][] cases = { { VWorldApiException.Reason.API_KEY_MISSING, 503 },
				{ VWorldApiException.Reason.TIMEOUT, 504 }, { VWorldApiException.Reason.API_ERROR, 502 },
				{ VWorldApiException.Reason.NETWORK_ERROR, 502 }, { VWorldApiException.Reason.UNEXPECTED_RESPONSE, 502 } };
		for (Object[] c : cases) {
			VWorldApiException.Reason reason = (VWorldApiException.Reason) c[0];
			willThrow(new VWorldApiException(reason, reason == VWorldApiException.Reason.API_ERROR ? "INVALID_KEY" : null,
					"실패")).given(this.searchClient).search("서울", SearchType.PLACE, 1);
			this.mockMvc.perform(get("/api/search").param("query", "서울"))
				.andExpect(status().is((int) c[1]))
				.andExpect(jsonPath("$.error").value(reason.name()));
		}
	}

	@Test
	void responseNeverContainsTheKeyOrTheVWorldUrl() throws Exception {
		given(this.searchClient.search("서울특별시청", SearchType.PLACE, 1))
			.willReturn(new SearchResult(true, 1, 1, 1, List.of(CITY_HALL), 0));

		String body = this.mockMvc.perform(get("/api/search").param("query", "서울특별시청"))
			.andReturn()
			.getResponse()
			.getContentAsString();

		assertThat(body).doesNotContain("key=").doesNotContain("api.vworld.kr").doesNotContain("skippedItems");
	}

}
