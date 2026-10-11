package com.example.gis_analysis_system.vworld;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.queryParam;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withServerError;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

import org.hamcrest.Matchers;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import com.example.gis_analysis_system.vworld.VWorldSearchClient.SearchType;

import tools.jackson.databind.json.JsonMapper;

/**
 * Uses a mocked VWorld server with response bodies shaped like the real ones received with the configured key
 * (place / road address / parcel address / NOT_FOUND).
 */
class VWorldSearchClientTests {

	private static final String PLACE_OK = """
			{"response": {"service": {"name": "search", "version": "2.0", "operation": "search", "time": "21(ms)"},
			 "status": "OK", "record": {"total": "34", "current": "2"},
			 "page": {"total": "4", "current": "1", "size": "10"},
			 "result": {"crs": "EPSG:4326", "type": "place", "items": [
			  {"id": "POI01000000M8XJGM", "title": "서울특별시청", "category": "지방행정기관 > 특별/광역시청",
			   "address": {"road": "서울특별시 중구 태평로1가 세종대로 110", "parcel": "서울특별시 중구 태평로1가 31"},
			   "point": {"x": "126.9783882002353", "y": "37.56661030125725"}},
			  {"id": "POI01000000BYB32L", "title": "<img src=x onerror=alert(1)>", "category": "지방행정기관",
			   "address": {"road": "", "parcel": "서울특별시 중구 태평로1가 31대"},
			   "point": {"x": "126.97819267651471", "y": "37.56655134090645"}}]}}}""";

	private static final String ROAD_OK = """
			{"response": {"status": "OK", "record": {"total": "2", "current": "2"},
			 "page": {"total": "1", "current": "1", "size": "10"},
			 "result": {"items": [
			  {"id": "1114010300100310000", "address": {"zipcode": "04524", "category": "road",
			   "road": "서울특별시 중구 세종대로 110 (태평로1가)", "parcel": "태평로1가 31", "bldnm": "서울특별시청", "bldnmdc": "본관동"},
			   "point": {"x": "126.9779183412472", "y": "37.566370785810435"}},
			  {"id": "1114010300100310000", "address": {"zipcode": "04524", "category": "road",
			   "road": "서울특별시 중구 세종대로 110 (태평로1가)", "parcel": "태평로1가 31", "bldnm": "", "bldnmdc": ""},
			   "point": {"x": "126.97834678005411", "y": "37.56670100709671"}}]}}}""";

	private static final String PARCEL_OK = """
			{"response": {"status": "OK", "record": {"total": "17", "current": "1"},
			 "page": {"total": "2", "current": "1", "size": "10"},
			 "result": {"items": [
			  {"id": "1114010300100310000", "address": {"zipcode": "04524", "category": "parcel",
			   "road": "세종대로 110", "parcel": "서울특별시 중구 태평로1가 31", "bldnm": "서울특별시청"},
			   "point": {"x": "126.9782290751147", "y": "37.56657117348658"}}]}}}""";

	private static final String NOT_FOUND = """
			{"response": {"status": "NOT_FOUND", "record": {"total": "0", "current": "0"},
			 "page": {"total": "1", "current": "1", "size": "10"}}}""";

	private MockRestServiceServer server;

	private VWorldSearchClient client;

	@BeforeEach
	void setUp() {
		RestClient.Builder builder = RestClient.builder();
		this.server = MockRestServiceServer.bindTo(builder).build();
		this.client = new VWorldSearchClient(builder, JsonMapper.builder().build(), " test-key ",
				"http://localhost:8080");
	}

	@Test
	void sendsDocumentedParametersForEachType() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andExpect(method(HttpMethod.GET))
			.andExpect(queryParam("service", "search"))
			.andExpect(queryParam("request", "search"))
			.andExpect(queryParam("version", "2.0"))
			.andExpect(queryParam("crs", "EPSG:4326"))
			.andExpect(queryParam("size", "10"))
			.andExpect(queryParam("page", "2"))
			.andExpect(queryParam("query", "%EC%84%9C%EC%9A%B8%20%EC%8B%9C%EC%B2%AD"))
			.andExpect(queryParam("type", "place"))
			.andExpect((request) -> assertThat(request.getURI().getRawQuery()).doesNotContain("category="))
			.andExpect(queryParam("format", "json"))
			.andExpect(queryParam("errorformat", "json"))
			.andExpect(queryParam("key", "test-key"))
			.andExpect(queryParam("domain", "http://localhost:8080"))
			.andRespond(withSuccess(NOT_FOUND, MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andExpect(queryParam("type", "address"))
			.andExpect(queryParam("category", "road"))
			.andRespond(withSuccess(NOT_FOUND, MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andExpect(queryParam("type", "address"))
			.andExpect(queryParam("category", "parcel"))
			.andRespond(withSuccess(NOT_FOUND, MediaType.APPLICATION_JSON));

		this.client.search("서울 시청", SearchType.PLACE, 2);
		this.client.search("세종대로 110", SearchType.ROAD, 1);
		this.client.search("태평로1가 31", SearchType.PARCEL, 1);

		this.server.verify();
	}

	@Test
	void specialCharactersInTheQueryAreEncodedAsData() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andExpect(queryParam("query", "a%26key%3Dx%23y"))
			.andExpect(queryParam("key", "test-key"))
			.andRespond(withSuccess(NOT_FOUND, MediaType.APPLICATION_JSON));

		this.client.search("a&key=x#y", SearchType.PLACE, 1);

		this.server.verify();
	}

	@Test
	void placeResultsAreParsed() {
		respond(PLACE_OK);

		SearchResult result = this.client.search("서울특별시청", SearchType.PLACE, 1);

		assertThat(result.found()).isTrue();
		assertThat(result.totalCount()).isEqualTo(34);
		assertThat(result.totalPages()).isEqualTo(4);
		assertThat(result.items()).hasSize(2);
		SearchResult.Item first = result.items().get(0);
		assertThat(first.id()).isEqualTo("POI01000000M8XJGM");
		assertThat(first.title()).isEqualTo("서울특별시청");
		assertThat(first.category()).isEqualTo("지방행정기관 > 특별/광역시청");
		assertThat(first.subtitle()).isEqualTo("서울특별시 중구 태평로1가 세종대로 110");
		assertThat(first.lon()).isEqualTo(126.9783882002353);
		assertThat(first.lat()).isEqualTo(37.56661030125725);
		// Text is passed through as data; escaping is the browser's job (textContent).
		assertThat(result.items().get(1).title()).isEqualTo("<img src=x onerror=alert(1)>");
		assertThat(result.items().get(1).subtitle()).isEqualTo("서울특별시 중구 태평로1가 31대");
	}

	@Test
	void roadAddressResultsUseTheAddressAsTitleAndTheBuildingNameAsSubtitle() {
		respond(ROAD_OK);

		SearchResult result = this.client.search("세종대로 110", SearchType.ROAD, 1);

		assertThat(result.items()).hasSize(2);
		assertThat(result.items().get(0).title()).isEqualTo("서울특별시 중구 세종대로 110 (태평로1가)");
		assertThat(result.items().get(0).subtitle()).isEqualTo("서울특별시청 본관동 · 태평로1가 31");
		assertThat(result.items().get(0).category()).isEqualTo("도로명 주소");
		assertThat(result.items().get(1).subtitle()).isEqualTo("태평로1가 31");
	}

	@Test
	void parcelAddressResultsUseTheParcelAsTitle() {
		respond(PARCEL_OK);

		SearchResult.Item item = this.client.search("태평로1가 31", SearchType.PARCEL, 1).items().get(0);

		assertThat(item.title()).isEqualTo("서울특별시 중구 태평로1가 31");
		assertThat(item.subtitle()).isEqualTo("서울특별시청 · 세종대로 110");
		assertThat(item.category()).isEqualTo("지번 주소");
		assertThat(item.roadAddress()).isEqualTo("세종대로 110");
		assertThat(item.parcelAddress()).isEqualTo("서울특별시 중구 태평로1가 31");
	}

	@Test
	void notFoundIsAnEmptyResult() {
		respond(NOT_FOUND);

		SearchResult result = this.client.search("없는장소", SearchType.PLACE, 1);

		assertThat(result.found()).isFalse();
		assertThat(result.items()).isEmpty();
		assertThat(result.totalCount()).isZero();
	}

	@Test
	void resultsWithoutValidCoordinatesAreSkipped() {
		respond("""
				{"response": {"status": "OK", "record": {"total": "5", "current": "5"}, "page": {"total": "1", "current": "1"},
				 "result": {"items": [
				  {"id": "a", "title": "범위 밖", "point": {"x": "139.69", "y": "35.68"}},
				  {"id": "b", "title": "숫자 아님", "point": {"x": "abc", "y": "37.5"}},
				  {"id": "c", "title": "좌표 없음"},
				  {"id": "d", "title": "NaN", "point": {"x": "NaN", "y": "37.5"}},
				  {"id": "e", "title": "정상", "point": {"x": "127.0", "y": "37.5"}}]}}}""");

		SearchResult result = this.client.search("테스트", SearchType.PLACE, 1);

		assertThat(result.items()).extracting(SearchResult.Item::id).containsExactly("e");
		assertThat(result.skippedItems()).isEqualTo(4);
	}

	@Test
	void vworldErrorIsReportedWithItsCode() {
		respond("""
				{"response": {"status": "ERROR", "error": {"level": "1", "code": "INVALID_KEY", "text": "등록되지 않은 인증키입니다."}}}""");

		assertThatExceptionOfType(VWorldApiException.class)
			.isThrownBy(() -> this.client.search("서울", SearchType.PLACE, 1))
			.satisfies((ex) -> {
				assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_ERROR);
				assertThat(ex.getVworldErrorCode()).isEqualTo("INVALID_KEY");
				assertThat(ex.getMessage()).doesNotContain("test-key");
			});
	}

	@Test
	void unexpectedResponsesAreRejected() {
		for (String body : new String[] { "<html>점검 중</html>", "{\"response\": {\"status\": \"OK\"}}",
				"{\"response\": {\"status\": \"WHAT\"}}", "" }) {
			respond(body);
			assertThatExceptionOfType(VWorldApiException.class)
				.isThrownBy(() -> this.client.search("서울", SearchType.PLACE, 1))
				.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.UNEXPECTED_RESPONSE));
			this.server.reset();
		}
	}

	@Test
	void timeoutHttpErrorAndNetworkFailureAreReportedWithoutTheKey() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andRespond(withException(new SocketTimeoutException("Read timed out")));
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andRespond(withServerError());
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andRespond(withException(new UnknownHostException("api.vworld.kr")));

		VWorldApiException.Reason[] expected = { VWorldApiException.Reason.TIMEOUT, VWorldApiException.Reason.API_ERROR,
				VWorldApiException.Reason.NETWORK_ERROR };
		for (VWorldApiException.Reason reason : expected) {
			assertThatExceptionOfType(VWorldApiException.class)
				.isThrownBy(() -> this.client.search("서울", SearchType.PLACE, 1))
				.satisfies((ex) -> {
					assertThat(ex.getReason()).isEqualTo(reason);
					assertThat(ex.getMessage()).doesNotContain("test-key").doesNotContain("api.vworld.kr/req");
				});
		}
	}

	@Test
	void missingKeyFailsWithoutCallingVWorld() {
		RestClient.Builder builder = RestClient.builder();
		MockRestServiceServer noCalls = MockRestServiceServer.bindTo(builder).build();
		VWorldSearchClient withoutKey = new VWorldSearchClient(builder, JsonMapper.builder().build(), " ", "");

		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> withoutKey.search("서울", SearchType.PLACE, 1))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_KEY_MISSING));
		noCalls.verify();
	}

	private void respond(String body) {
		this.server.expect(requestTo(Matchers.startsWith(VWorldSearchClient.SEARCH_API_URL)))
			.andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
	}

}
