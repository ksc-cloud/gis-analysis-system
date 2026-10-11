package com.example.gis_analysis_system.spatial;

import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.Semaphore;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Calls the Python analysis service (server to server; the browser never sees its address or token).
 * <p>
 * Every call is checked in this order: configuration (token and loopback URL), request size, the cooldown after a
 * connection failure, the concurrent request limit; only then is Python called, once. There are no automatic retries:
 * the analyses are CPU heavy, so a failure is reported at once and the user decides whether to try again.
 * <p>
 * Logs carry the endpoint, status, request size and duration only: never the token, the request body or Python's
 * response body.
 */
@Component
public class AnalysisServiceClient {

	static final String TOKEN_HEADER = "X-Internal-Token";

	private static final Logger logger = LoggerFactory.getLogger(AnalysisServiceClient.class);

	/** Python endpoints with their response check. */
	public enum Endpoint {

		BUILDING_STATS("/internal/v1/building-stats", PythonResponseValidator::buildingStats),

		GRID_DENSITY("/internal/v1/grid-density", PythonResponseValidator::gridDensity),

		COMPARE("/internal/v1/compare-analyses", PythonResponseValidator::compare),

		HOTSPOT("/internal/v1/hotspot", PythonResponseValidator::hotspot);

		private final String path;

		private final Consumer<JsonNode> validator;

		Endpoint(String path, Consumer<JsonNode> validator) {
			this.path = path;
			this.validator = validator;
		}

		public String path() {
			return this.path;
		}

	}

	private final AnalysisServiceProperties properties;

	private final JsonMapper jsonMapper;

	private final RestClient analysisClient;

	private final RestClient compareClient;

	private final RestClient statusClient;

	private final Clock clock;

	private final Semaphore permits;

	private final String configurationProblem;

	/** Connection failures make every request fail at once until this instant. */
	private volatile Instant unavailableUntil = Instant.MIN;

	@Autowired
	public AnalysisServiceClient(AnalysisServiceProperties properties, JsonMapper jsonMapper) {
		this(properties, jsonMapper,
				RestClient.builder().requestFactory(requestFactory(properties.connectTimeout(), properties.readTimeout())),
				RestClient.builder()
					.requestFactory(requestFactory(properties.connectTimeout(), properties.compareReadTimeout())),
				RestClient.builder()
					.requestFactory(requestFactory(properties.statusTimeout(), properties.statusTimeout())),
				Clock.systemUTC());
	}

	/** Tests: one builder for all calls (MockRestServiceServer) or real request factories. */
	AnalysisServiceClient(AnalysisServiceProperties properties, JsonMapper jsonMapper, RestClient.Builder analysis,
			RestClient.Builder compare, RestClient.Builder status, Clock clock) {
		this.properties = properties;
		this.jsonMapper = jsonMapper;
		this.analysisClient = analysis.build();
		this.compareClient = compare.build();
		this.statusClient = status.build();
		this.clock = clock;
		this.permits = new Semaphore(properties.maxConcurrentRequests());
		this.configurationProblem = properties.configurationProblem();
		if (this.configurationProblem != null) {
			logger.warn("Python analysis service integration disabled: {}", this.configurationProblem);
		}
	}

	static SimpleClientHttpRequestFactory requestFactory(Duration connectTimeout, Duration readTimeout) {
		SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
		factory.setConnectTimeout(connectTimeout);
		factory.setReadTimeout(readTimeout);
		return factory;
	}

	public boolean isConfigured() {
		return this.configurationProblem == null;
	}

	/**
	 * Fails fast when Python cannot be used right now (not configured, or within the cooldown after a connection
	 * failure), so callers can skip loading an analysis they could not send anyway.
	 */
	public void requireAvailable() {
		if (!isConfigured()) {
			throw notConfigured();
		}
		if (this.clock.instant().isBefore(this.unavailableUntil)) {
			throw unavailable();
		}
	}

	/**
	 * Sends one request and returns the validated JSON response.
	 *
	 * @throws AnalysisServiceException for every failure, already translated for the browser
	 */
	public JsonNode post(Endpoint endpoint, byte[] body) {
		requireAvailable();
		long limit = (endpoint == Endpoint.COMPARE) ? this.properties.compareMaxRequestBytes().toBytes()
				: this.properties.maxRequestBytes().toBytes();
		if (body.length > limit) {
			logger.info("Python {} not called: request of {} bytes exceeds {} bytes", endpoint.path, body.length,
					limit);
			throw tooLarge();
		}
		if (!this.permits.tryAcquire()) {
			logger.info("Python {} not called: {} requests already running", endpoint.path,
					this.properties.maxConcurrentRequests());
			throw new AnalysisServiceException(Reason.ANALYSIS_SERVICE_BUSY,
					"분석 서버가 다른 분석을 처리하고 있습니다. 잠시 후 다시 시도하세요.");
		}
		long started = System.nanoTime();
		try {
			Response response = send(endpoint, body);
			this.unavailableUntil = Instant.MIN;
			logger.info("Python {} answered {} ({} request bytes, {} ms)", endpoint.path, response.status, body.length,
					(System.nanoTime() - started) / 1_000_000);
			return handle(endpoint, response);
		}
		finally {
			this.permits.release();
		}
	}

	/** Python /health within the short status timeout. Never throws. */
	public boolean isAvailable() {
		if (!isConfigured()) {
			return false;
		}
		try {
			Response response = this.statusClient.get()
				.uri(this.properties.normalizedBaseUrl() + "/health")
				.accept(MediaType.APPLICATION_JSON)
				.exchange((request, http) -> new Response(http.getStatusCode().value(), read(http.getBody(), 4096)),
						false);
			if (response.status != 200 || response.body == null) {
				return false;
			}
			JsonNode health = this.jsonMapper.readTree(response.body);
			return health.isObject() && "ok".equals(health.path("status").asString(null));
		}
		catch (RuntimeException ex) {
			logger.debug("Python /health failed: {}", ex.getClass().getSimpleName());
			return false;
		}
	}

	private record Response(int status, byte[] body) {
	}

	private Response send(Endpoint endpoint, byte[] body) {
		RestClient client = (endpoint == Endpoint.COMPARE) ? this.compareClient : this.analysisClient;
		long maxResponse = this.properties.maxResponseBytes().toBytes();
		try {
			return client.post()
				.uri(this.properties.normalizedBaseUrl() + endpoint.path)
				.contentType(MediaType.APPLICATION_JSON)
				.accept(MediaType.APPLICATION_JSON)
				.header(TOKEN_HEADER, this.properties.internalToken())
				.body(body)
				.exchange((request, http) -> new Response(http.getStatusCode().value(),
						read(http.getBody(), maxResponse)), false);
		}
		catch (ResourceAccessException ex) {
			throw translate(endpoint, ex);
		}
		catch (RestClientException ex) {
			logger.warn("Python {} request failed: {}", endpoint.path, ex.getClass().getSimpleName());
			throw new AnalysisServiceException(Reason.ANALYSIS_SERVICE_ERROR, "분석 서버와 통신하는 중 오류가 발생했습니다.");
		}
	}

	/** Connection failures start the cooldown; a response timeout does not (Python is up but busy). */
	private AnalysisServiceException translate(Endpoint endpoint, ResourceAccessException ex) {
		Throwable cause = (ex.getCause() != null) ? ex.getCause() : ex;
		if (cause instanceof ResponseTooLargeException) {
			logger.warn("Python {} response exceeds {}", endpoint.path, this.properties.maxResponseBytes());
			return badResponse();
		}
		if (isResponseTimeout(cause)) {
			logger.warn("Python {} did not answer within the response timeout", endpoint.path);
			return new AnalysisServiceException(Reason.ANALYSIS_SERVICE_TIMEOUT,
					"분석 서버의 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.");
		}
		this.unavailableUntil = this.clock.instant().plus(this.properties.unavailableCooldown());
		logger.warn("Python {} unreachable ({}); requests fail at once for {}", endpoint.path,
				cause.getClass().getSimpleName(), this.properties.unavailableCooldown());
		return unavailable();
	}

	/**
	 * HttpURLConnection reports both timeouts as SocketTimeoutException: "Connect timed out" for the connection,
	 * "Read timed out" for the response.
	 */
	static boolean isResponseTimeout(Throwable cause) {
		if (cause instanceof HttpConnectTimeoutException) {
			return false;
		}
		if (cause instanceof HttpTimeoutException) {
			return true;
		}
		if (cause instanceof SocketTimeoutException) {
			String message = (cause.getMessage() != null) ? cause.getMessage().toLowerCase(Locale.ROOT) : "";
			return !message.contains("connect");
		}
		return false;
	}

	private JsonNode handle(Endpoint endpoint, Response response) {
		if (response.status == 200) {
			try {
				JsonNode root = this.jsonMapper.readTree(response.body);
				endpoint.validator.accept(root);
				return root;
			}
			catch (JacksonException | PythonResponseValidator.InvalidResponseException ex) {
				logger.warn("Python {} returned an invalid body: {}", endpoint.path,
						(ex instanceof PythonResponseValidator.InvalidResponseException) ? ex.getMessage()
								: "not JSON");
				throw badResponse();
			}
		}
		String serviceError = errorCode(response.body);
		AnalysisServiceException failure = switch (response.status) {
			case 401 -> {
				logger.error("Python {} rejected the internal token (401): check ANALYSIS_INTERNAL_TOKEN on both servers",
						endpoint.path);
				yield new AnalysisServiceException(Reason.ANALYSIS_SERVICE_AUTH_FAILED,
						"분석 서버 인증에 실패했습니다. 서버 설정을 확인해야 합니다.");
			}
			case 413 -> tooLarge();
			case 422 -> {
				logger.warn("Python {} rejected the analysis data (422 {})", endpoint.path, serviceError);
				yield new AnalysisServiceException(Reason.ANALYSIS_DATA_UNSUPPORTED,
						"분석 서버가 이 분석 데이터를 처리할 수 없습니다.", serviceError);
			}
			case 503 -> {
				logger.warn("Python {} unavailable (503 {})", endpoint.path, serviceError);
				yield unavailable();
			}
			default -> {
				logger.warn("Python {} failed with HTTP {} ({})", endpoint.path, response.status, serviceError);
				yield new AnalysisServiceException(Reason.ANALYSIS_SERVICE_ERROR, "분석 서버에서 오류가 발생했습니다.");
			}
		};
		throw failure;
	}

	/** Python's {@code error} code of an error body, or {@code null}. Its message is never passed on. */
	private String errorCode(byte[] body) {
		if (body == null || body.length == 0) {
			return null;
		}
		try {
			JsonNode error = this.jsonMapper.readTree(body).path("error");
			return error.isString() ? error.asString() : null;
		}
		catch (JacksonException ex) {
			return null;
		}
	}

	private static byte[] read(InputStream body, long limit) throws IOException {
		if (body == null) {
			return new byte[0];
		}
		byte[] bytes = body.readNBytes((int) Math.min(Integer.MAX_VALUE - 8, limit + 1));
		if (bytes.length > limit) {
			throw new ResponseTooLargeException();
		}
		return bytes;
	}

	private static final class ResponseTooLargeException extends IOException {

		ResponseTooLargeException() {
			super("response too large");
		}

	}

	private static AnalysisServiceException notConfigured() {
		return new AnalysisServiceException(Reason.ANALYSIS_SERVICE_NOT_CONFIGURED,
				"공간 분석 서버 연동이 설정되지 않았습니다. 지도와 반경 분석은 계속 사용할 수 있습니다.");
	}

	private static AnalysisServiceException unavailable() {
		return new AnalysisServiceException(Reason.ANALYSIS_SERVICE_UNAVAILABLE,
				"공간 분석 서버에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다.");
	}

	private static AnalysisServiceException tooLarge() {
		return new AnalysisServiceException(Reason.ANALYSIS_TOO_LARGE, "분석 데이터가 분석 서버가 처리할 수 있는 크기를 넘습니다.");
	}

	private static AnalysisServiceException badResponse() {
		return new AnalysisServiceException(Reason.ANALYSIS_SERVICE_BAD_RESPONSE, "분석 서버의 응답 형식이 올바르지 않습니다.");
	}

}
