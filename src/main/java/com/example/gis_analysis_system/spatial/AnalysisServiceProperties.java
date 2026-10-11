package com.example.gis_analysis_system.spatial;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.time.Duration;
import java.util.Locale;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.StringUtils;
import org.springframework.util.unit.DataSize;

/**
 * Connection to the Python analysis service (analysis-service/, FastAPI on 127.0.0.1:8001).
 * <p>
 * The internal token comes only from ANALYSIS_INTERNAL_TOKEN (or the git-ignored application-local.properties) and
 * is never logged: {@link #toString()} hides it. The base URL must be http(s) on a loopback address, so a
 * misconfiguration can never send the token to another machine; any other value disables the integration
 * (see {@link #configurationProblem()}) instead of stopping the application.
 *
 * @param baseUrl Python service root, for example {@code http://127.0.0.1:8001}
 * @param internalToken value of the X-Internal-Token header
 * @param connectTimeout connection timeout (loopback: a refused connection fails at once)
 * @param readTimeout response timeout of building-stats and grid-density
 * @param compareReadTimeout response timeout of compare-analyses
 * @param statusTimeout connection and response timeout of the /health check
 * @param maxConcurrentRequests analysis requests sent to Python at the same time; more are rejected (no queue)
 * @param unavailableCooldown after a connection failure, requests fail at once for this long
 * @param maxRequestBytes largest building-stats / grid-density request body (Python default 16 MiB)
 * @param compareMaxRequestBytes largest compare-analyses request body (Python default 32 MiB)
 * @param maxResponseBytes largest response body read from Python
 */
@ConfigurationProperties("analysis-service")
public record AnalysisServiceProperties(@DefaultValue("http://127.0.0.1:8001") String baseUrl, String internalToken,
		@DefaultValue("1s") Duration connectTimeout, @DefaultValue("15s") Duration readTimeout,
		@DefaultValue("30s") Duration compareReadTimeout, @DefaultValue("2s") Duration statusTimeout,
		@DefaultValue("2") int maxConcurrentRequests, @DefaultValue("10s") Duration unavailableCooldown,
		@DefaultValue("16MB") DataSize maxRequestBytes, @DefaultValue("32MB") DataSize compareMaxRequestBytes,
		@DefaultValue("64MB") DataSize maxResponseBytes) {

	public AnalysisServiceProperties {
		baseUrl = (baseUrl != null) ? baseUrl.trim() : "";
		internalToken = StringUtils.hasText(internalToken) ? internalToken.trim() : null;
		connectTimeout = positive(connectTimeout, Duration.ofSeconds(1));
		readTimeout = positive(readTimeout, Duration.ofSeconds(15));
		compareReadTimeout = positive(compareReadTimeout, Duration.ofSeconds(30));
		statusTimeout = positive(statusTimeout, Duration.ofSeconds(2));
		maxConcurrentRequests = (maxConcurrentRequests > 0) ? maxConcurrentRequests : 2;
		unavailableCooldown = (unavailableCooldown != null && !unavailableCooldown.isNegative()) ? unavailableCooldown
				: Duration.ofSeconds(10);
		maxRequestBytes = positive(maxRequestBytes, DataSize.ofMegabytes(16));
		compareMaxRequestBytes = positive(compareMaxRequestBytes, DataSize.ofMegabytes(32));
		maxResponseBytes = positive(maxResponseBytes, DataSize.ofMegabytes(64));
	}

	/** Defaults with the given URL and token (tests). */
	public static AnalysisServiceProperties of(String baseUrl, String internalToken) {
		return new AnalysisServiceProperties(baseUrl, internalToken, null, null, null, null, 0, null, null, null, null);
	}

	/** Why the integration cannot be used, or {@code null} when the URL and the token are both usable. */
	public String configurationProblem() {
		String urlProblem = urlProblem(this.baseUrl);
		if (urlProblem != null) {
			return urlProblem;
		}
		return (this.internalToken == null) ? "ANALYSIS_INTERNAL_TOKEN이 설정되지 않았습니다." : null;
	}

	public boolean isConfigured() {
		return configurationProblem() == null;
	}

	/** The base URL without a trailing slash; only meaningful when {@link #urlProblem} found nothing. */
	public String normalizedBaseUrl() {
		return this.baseUrl.endsWith("/") ? this.baseUrl.substring(0, this.baseUrl.length() - 1) : this.baseUrl;
	}

	/** {@code null} when the URL is http(s)://loopback[:port][/] without user info, path, query or fragment. */
	static String urlProblem(String value) {
		URI uri;
		try {
			uri = new URI(value);
		}
		catch (URISyntaxException ex) {
			return "analysis-service.base-url 형식이 올바르지 않습니다.";
		}
		String scheme = (uri.getScheme() != null) ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
		if (!scheme.equals("http") && !scheme.equals("https")) {
			return "analysis-service.base-url은 http 또는 https 주소여야 합니다.";
		}
		if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
				|| (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/"))) {
			return "analysis-service.base-url에는 호스트와 포트만 지정할 수 있습니다.";
		}
		if (!isLoopback(uri.getHost())) {
			return "analysis-service.base-url은 loopback 주소(127.0.0.1, localhost, ::1)만 허용합니다.";
		}
		return null;
	}

	/** Literal loopback addresses and "localhost" only: no DNS lookup of other names. */
	static boolean isLoopback(String host) {
		if (host == null || host.isEmpty()) {
			return false;
		}
		String name = host.toLowerCase(Locale.ROOT);
		if (name.equals("localhost")) {
			return true;
		}
		if (name.startsWith("[") && name.endsWith("]")) {
			name = name.substring(1, name.length() - 1);
		}
		boolean ipv4 = name.matches("\\d{1,3}(\\.\\d{1,3}){3}");
		boolean ipv6 = name.contains(":") && name.matches("[0-9a-f:.]+");
		if (!ipv4 && !ipv6) {
			return false;
		}
		try {
			// A literal address is parsed, not resolved.
			return InetAddress.getByName(name).isLoopbackAddress();
		}
		catch (UnknownHostException ex) {
			return false;
		}
	}

	@Override
	public String toString() {
		return "AnalysisServiceProperties[baseUrl=" + this.baseUrl + ", internalToken="
				+ ((this.internalToken != null) ? "(set)" : "(not set)") + ", connectTimeout=" + this.connectTimeout
				+ ", readTimeout=" + this.readTimeout + ", compareReadTimeout=" + this.compareReadTimeout
				+ ", statusTimeout=" + this.statusTimeout + ", maxConcurrentRequests=" + this.maxConcurrentRequests
				+ ", unavailableCooldown=" + this.unavailableCooldown + ", maxRequestBytes=" + this.maxRequestBytes
				+ ", compareMaxRequestBytes=" + this.compareMaxRequestBytes + ", maxResponseBytes="
				+ this.maxResponseBytes + "]";
	}

	private static Duration positive(Duration value, Duration fallback) {
		return (value != null && !value.isNegative() && !value.isZero()) ? value : fallback;
	}

	private static DataSize positive(DataSize value, DataSize fallback) {
		return (value != null && value.toBytes() > 0) ? value : fallback;
	}

}
