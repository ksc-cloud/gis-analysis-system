package com.example.gis_analysis_system.web;

import java.net.ConnectException;
import java.net.URI;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLTransientConnectionException;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.dao.TransientDataAccessResourceException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.history.AnalysisHistoryService.HistoryPage;
import com.example.gis_analysis_system.history.AnalysisHistoryService.SavedAnalysis;
import com.example.gis_analysis_system.history.HistorySort;
import com.fasterxml.jackson.annotation.JsonInclude;

import tools.jackson.databind.JsonNode;

/**
 * Analysis history: save a radius analysis by its token, list, show (restored without calling VWorld) and delete.
 * <p>
 * Only these endpoints need the database. When it cannot be reached they answer 503 and every other feature of the
 * map keeps working. Errors are {@code {"error", "message"}} like the building API; database details are only logged.
 */
@RestController
@RequestMapping("/api/analyses")
public class AnalysisHistoryController {

	private static final Logger logger = LoggerFactory.getLogger(AnalysisHistoryController.class);

	private static final Set<String> SAVE_FIELDS = Set.of("analysisToken", "title");

	private final AnalysisHistoryService historyService;

	public AnalysisHistoryController(AnalysisHistoryService historyService) {
		this.historyService = historyService;
	}

	/** No consumes condition, so a non-JSON body fails while reading it and still gets this API's error format. */
	@PostMapping
	public ResponseEntity<SavedAnalysis> save(@RequestBody JsonNode body) {
		if (body == null || !body.isObject()) {
			throw new InvalidRequestException("요청 본문은 {\"analysisToken\", \"title\"} 형태의 JSON 객체여야 합니다.");
		}
		for (String field : body.propertyNames()) {
			if (!SAVE_FIELDS.contains(field)) {
				throw new InvalidRequestException("알 수 없는 필드가 있습니다. analysisToken과 title만 보낼 수 있습니다.");
			}
		}
		JsonNode token = body.get("analysisToken");
		JsonNode title = body.get("title");
		if (token != null && !token.isString()) {
			throw new AnalysisHistoryException(Code.INVALID_TOKEN, "analysisToken은 문자열이어야 합니다.");
		}
		if (title != null && !title.isString()) {
			throw new AnalysisHistoryException(Code.INVALID_TITLE, "title은 문자열이어야 합니다.");
		}
		SavedAnalysis saved = this.historyService.save((token != null) ? token.asString() : null,
				(title != null) ? title.asString() : null);
		return ResponseEntity.created(URI.create("/api/analyses/" + saved.analysisId())).body(saved);
	}

	@GetMapping
	public HistoryPage list(@RequestParam(required = false) String page, @RequestParam(required = false) String size,
			@RequestParam(required = false) String sort) {
		return this.historyService.list(parsePageNumber(page, 1), parsePageNumber(size,
				AnalysisHistoryService.DEFAULT_PAGE_SIZE), parseSort(sort));
	}

	@GetMapping("/{id}")
	public AnalysisDetail get(@PathVariable String id) {
		return this.historyService.get(parseId(id));
	}

	@DeleteMapping("/{id}")
	public ResponseEntity<Void> delete(@PathVariable String id) {
		this.historyService.delete(parseId(id));
		return ResponseEntity.noContent().build();
	}

	// ----------------------------------------------------------------- error mapping

	@ExceptionHandler(AnalysisHistoryException.class)
	ResponseEntity<HistoryApiError> handleHistoryError(AnalysisHistoryException ex) {
		HttpStatus status = switch (ex.getCode()) {
			case INVALID_TOKEN, INVALID_TITLE, INVALID_PAGE, INVALID_SORT, INVALID_ID -> HttpStatus.BAD_REQUEST;
			case ANALYSIS_NOT_FOUND -> HttpStatus.NOT_FOUND;
			case ALREADY_SAVED, HISTORY_LIMIT -> HttpStatus.CONFLICT;
			case SNAPSHOT_EXPIRED -> HttpStatus.GONE;
			case UNSUPPORTED_RESULT -> HttpStatus.UNPROCESSABLE_CONTENT;
			case STORED_DATA_INVALID -> HttpStatus.INTERNAL_SERVER_ERROR;
		};
		if (status == HttpStatus.INTERNAL_SERVER_ERROR) {
			logger.error("Saved analysis could not be read: {}", ex.getMessage());
		}
		return ResponseEntity.status(status)
			.body(new HistoryApiError(ex.getCode().name(), ex.getMessage(), ex.getAnalysisId()));
	}

	@ExceptionHandler(InvalidRequestException.class)
	ResponseEntity<HistoryApiError> handleInvalidRequest(InvalidRequestException ex) {
		return ResponseEntity.badRequest().body(new HistoryApiError("INVALID_REQUEST", ex.getMessage(), null));
	}

	@ExceptionHandler(HttpMessageNotReadableException.class)
	ResponseEntity<HistoryApiError> handleUnreadableBody(HttpMessageNotReadableException ex) {
		if (hasCause(ex, AnalysisRequestSizeFilter.PayloadTooLargeException.class)) {
			return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE)
				.body(new HistoryApiError("PAYLOAD_TOO_LARGE", AnalysisRequestSizeFilter.PayloadTooLargeException.MESSAGE,
						null));
		}
		return ResponseEntity.badRequest()
			.body(new HistoryApiError("INVALID_REQUEST", "요청 본문이 올바른 JSON이 아닙니다.", null));
	}

	@ExceptionHandler(HttpMediaTypeNotSupportedException.class)
	ResponseEntity<HistoryApiError> handleMediaType(HttpMediaTypeNotSupportedException ex) {
		return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
			.body(new HistoryApiError("UNSUPPORTED_MEDIA_TYPE", "Content-Type은 application/json이어야 합니다.", null));
	}

	@ExceptionHandler({ DataAccessException.class, TransactionException.class })
	ResponseEntity<HistoryApiError> handleDatabaseError(RuntimeException ex) {
		if (isDatabaseUnavailable(ex)) {
			logger.warn("Analysis history database unavailable: {}", rootCause(ex).getClass().getName());
			return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
				.body(new HistoryApiError("DB_UNAVAILABLE",
						"분석 이력 데이터베이스에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다.", null));
		}
		logger.error("Analysis history database error: {} (root cause {})", ex.getClass().getName(),
				rootCause(ex).getClass().getName());
		return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
			.body(new HistoryApiError("DB_ERROR", "분석 이력을 처리하는 중 데이터베이스 오류가 발생했습니다.", null));
	}

	/**
	 * Connection problems surface as different types depending on where they happen (pool, transaction start,
	 * MyBatis wrapping), so the whole cause chain is checked.
	 */
	static boolean isDatabaseUnavailable(Throwable ex) {
		for (Throwable t = ex; t != null; t = (t.getCause() == t) ? null : t.getCause()) {
			if (t instanceof CannotCreateTransactionException || t instanceof DataAccessResourceFailureException
					|| t instanceof TransientDataAccessResourceException || t instanceof QueryTimeoutException
					|| t instanceof SQLTransientConnectionException || t instanceof SQLNonTransientConnectionException
					|| t instanceof ConnectException) {
				return true;
			}
		}
		return false;
	}

	private static boolean hasCause(Throwable ex, Class<? extends Throwable> type) {
		for (Throwable t = ex; t != null; t = (t.getCause() == t) ? null : t.getCause()) {
			if (type.isInstance(t)) {
				return true;
			}
		}
		return false;
	}

	private static Throwable rootCause(Throwable ex) {
		Throwable root = ex;
		while (root.getCause() != null && root.getCause() != root) {
			root = root.getCause();
		}
		return root;
	}

	// ----------------------------------------------------------------- parameter parsing

	private static int parsePageNumber(String value, int defaultValue) {
		if (value == null) {
			return defaultValue;
		}
		if (!value.matches("\\d{1,6}")) {
			throw new AnalysisHistoryException(Code.INVALID_PAGE, "page와 size는 양의 정수여야 합니다.");
		}
		return Integer.parseInt(value);
	}

	private static HistorySort parseSort(String value) {
		if (value == null) {
			return HistorySort.SAVED_DESC;
		}
		for (HistorySort sort : HistorySort.values()) {
			if (sort.name().equals(value)) {
				return sort;
			}
		}
		throw new AnalysisHistoryException(Code.INVALID_SORT,
				"sort는 SAVED_DESC, SAVED_ASC, TITLE_ASC, BUILDINGS_DESC 중 하나여야 합니다.");
	}

	private static long parseId(String value) {
		if (value == null || !value.matches("\\d{1,18}")) {
			throw new AnalysisHistoryException(Code.INVALID_ID, "분석 이력 ID는 1 이상의 정수여야 합니다.");
		}
		return Long.parseLong(value);
	}

	@JsonInclude(JsonInclude.Include.NON_NULL)
	record HistoryApiError(String error, String message, Long analysisId) {
	}

	static final class InvalidRequestException extends RuntimeException {

		InvalidRequestException(String message) {
			super(message);
		}

	}

}
