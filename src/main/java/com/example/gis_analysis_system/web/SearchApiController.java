package com.example.gis_analysis_system.web;

import java.util.List;
import java.util.Locale;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.example.gis_analysis_system.vworld.SearchResult;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldSearchClient;
import com.example.gis_analysis_system.vworld.VWorldSearchClient.SearchType;

/**
 * Map search (places/buildings by name, road addresses, parcel addresses) through the VWorld Search API 2.0.
 * The browser never sees the API key. Errors use the same {@code {"error", "message", "vworldErrorCode"}} shape and
 * status codes as the building API.
 */
@RestController
@RequestMapping("/api/search")
public class SearchApiController {

	public static final int MIN_QUERY_LENGTH = 2;

	public static final int MAX_QUERY_LENGTH = 100;

	static final int MAX_PAGE = 100;

	private final VWorldSearchClient searchClient;

	public SearchApiController(VWorldSearchClient searchClient) {
		this.searchClient = searchClient;
	}

	@GetMapping
	public ResponseEntity<?> search(@RequestParam(required = false) String query,
			@RequestParam(required = false) String type, @RequestParam(required = false) String page) {
		String normalizedQuery = normalizeQuery(query);
		if (normalizedQuery == null) {
			return badRequest("INVALID_QUERY", "검색어는 앞뒤 공백을 빼고 " + MIN_QUERY_LENGTH + "~" + MAX_QUERY_LENGTH
					+ "자로 입력하세요. 줄바꿈 같은 제어 문자는 쓸 수 없습니다.");
		}
		SearchType searchType = parseType(type);
		if (searchType == null) {
			return badRequest("INVALID_TYPE", "검색 유형은 place(장소·건물명), road(도로명 주소), parcel(지번 주소) 중 하나여야 합니다.");
		}
		Integer pageNumber = parsePage(page);
		if (pageNumber == null) {
			return badRequest("INVALID_PAGE", "page는 1~" + MAX_PAGE + " 사이의 정수여야 합니다.");
		}
		SearchResult result = this.searchClient.search(normalizedQuery, searchType, pageNumber);
		return ResponseEntity.ok(new SearchResponse(result.found() && !result.items().isEmpty() ? "FOUND" : "NOT_FOUND",
				normalizedQuery, searchType.name().toLowerCase(Locale.ROOT), pageNumber, Math.max(result.totalPages(), 0),
				Math.max(result.totalCount(), 0), VWorldSearchClient.PAGE_SIZE, result.items()));
	}

	@ExceptionHandler(VWorldApiException.class)
	ResponseEntity<SearchError> handleVWorldError(VWorldApiException ex) {
		HttpStatus status = switch (ex.getReason()) {
			case API_KEY_MISSING -> HttpStatus.SERVICE_UNAVAILABLE;
			case TIMEOUT -> HttpStatus.GATEWAY_TIMEOUT;
			case API_ERROR, NETWORK_ERROR, UNEXPECTED_RESPONSE -> HttpStatus.BAD_GATEWAY;
		};
		return ResponseEntity.status(status)
			.body(new SearchError(ex.getReason().name(), ex.getMessage(), ex.getVworldErrorCode()));
	}

	/** Trimmed, 2~100 characters (code points), no control characters. */
	static String normalizeQuery(String value) {
		if (value == null) {
			return null;
		}
		String query = value.strip();
		int length = query.codePointCount(0, query.length());
		boolean valid = length >= MIN_QUERY_LENGTH && length <= MAX_QUERY_LENGTH
				&& query.codePoints().noneMatch((cp) -> Character.isISOControl(cp) || Character.getType(cp) == Character.SURROGATE);
		return valid ? query : null;
	}

	private static SearchType parseType(String value) {
		if (value == null || value.isEmpty()) {
			return SearchType.PLACE;
		}
		for (SearchType type : SearchType.values()) {
			if (type.name().toLowerCase(Locale.ROOT).equals(value)) {
				return type;
			}
		}
		return null;
	}

	private static Integer parsePage(String value) {
		if (value == null || value.isEmpty()) {
			return 1;
		}
		if (!value.matches("\\d{1,3}")) {
			return null;
		}
		int page = Integer.parseInt(value);
		return (page >= 1 && page <= MAX_PAGE) ? page : null;
	}

	private static ResponseEntity<SearchError> badRequest(String error, String message) {
		return ResponseEntity.badRequest().body(new SearchError(error, message, null));
	}

	/**
	 * @param status FOUND or NOT_FOUND
	 * @param type place, road or parcel
	 * @param totalPages pages reported by VWorld (0 when nothing was found)
	 * @param totalCount results reported by VWorld
	 */
	record SearchResponse(String status, String query, String type, int page, int totalPages, int totalCount,
			int pageSize, List<SearchResult.Item> items) {
	}

	record SearchError(String error, String message, String vworldErrorCode) {
	}

}
