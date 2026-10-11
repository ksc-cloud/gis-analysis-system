package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

import com.example.gis_analysis_system.spatial.AnalysisServiceClient.Endpoint;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;

import tools.jackson.databind.json.JsonMapper;

/**
 * The client with its real request factories (HttpURLConnection) against loopback sockets: a closed port, a server
 * that never answers, and a slow server for the concurrent request limit. No Python is needed.
 */
class AnalysisServiceClientNetworkTests {

	private static final byte[] BODY = "{}".getBytes(StandardCharsets.UTF_8);

	private ServerSocket serverSocket;

	@AfterEach
	void closeServer() throws IOException {
		if (this.serverSocket != null) {
			this.serverSocket.close();
		}
	}

	@Test
	void pythonNotRunningIsUnavailable() throws IOException {
		int port;
		try (ServerSocket probe = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
			port = probe.getLocalPort();
		}
		AnalysisServiceClient client = client(port, Duration.ofSeconds(2), 2);

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		assertThat(client.isAvailable()).isFalse();
		// The cooldown answers the next call without a connection attempt.
		long started = System.nanoTime();
		assertReason(() -> client.post(Endpoint.GRID_DENSITY, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(200));
	}

	@Test
	void serverThatNeverAnswersTimesOut() throws Exception {
		this.serverSocket = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
		CountDownLatch release = new CountDownLatch(1);
		CompletableFuture.runAsync(() -> acceptAndHold(release));
		AnalysisServiceClient client = client(this.serverSocket.getLocalPort(), Duration.ofMillis(300), 2);

		long started = System.nanoTime();
		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_TIMEOUT);
		assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
		// A response timeout does not start the cooldown.
		client.requireAvailable();
		release.countDown();
	}

	@Test
	void concurrentRequestsOverTheLimitAreBusy() throws Exception {
		this.serverSocket = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
		CountDownLatch release = new CountDownLatch(1);
		AtomicInteger accepted = new AtomicInteger();
		CompletableFuture.runAsync(() -> {
			while (!this.serverSocket.isClosed()) {
				try {
					Socket socket = this.serverSocket.accept();
					accepted.incrementAndGet();
					CompletableFuture.runAsync(() -> answerAfter(socket, release));
				}
				catch (IOException ex) {
					return;
				}
			}
		});
		AnalysisServiceClient client = client(this.serverSocket.getLocalPort(), Duration.ofSeconds(10), 1);

		CompletableFuture<Reason> first = CompletableFuture.supplyAsync(() -> reasonOf(client));
		waitUntil(() -> accepted.get() == 1);
		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_BUSY);
		release.countDown();

		// The held request finishes (Python answered 500) and frees its permit.
		assertThat(first.get(10, TimeUnit.SECONDS)).isEqualTo(Reason.ANALYSIS_SERVICE_ERROR);
		assertThat(reasonOf(client)).isEqualTo(Reason.ANALYSIS_SERVICE_ERROR);
		assertThat(accepted.get()).isEqualTo(2);
	}

	// ----------------------------------------------------------------- helpers

	private static AnalysisServiceClient client(int port, Duration readTimeout, int maxConcurrent) {
		AnalysisServiceProperties properties = new AnalysisServiceProperties("http://127.0.0.1:" + port,
				SpatialFixtures.TOKEN, Duration.ofSeconds(1), readTimeout, readTimeout, Duration.ofMillis(500),
				maxConcurrent, Duration.ofSeconds(10), null, null, null);
		return new AnalysisServiceClient(properties, JsonMapper.builder().build(),
				RestClient.builder()
					.requestFactory(AnalysisServiceClient.requestFactory(properties.connectTimeout(), readTimeout)),
				RestClient.builder()
					.requestFactory(AnalysisServiceClient.requestFactory(properties.connectTimeout(), readTimeout)),
				RestClient.builder()
					.requestFactory(AnalysisServiceClient.requestFactory(properties.statusTimeout(),
							properties.statusTimeout())),
				Clock.systemUTC());
	}

	private void acceptAndHold(CountDownLatch release) {
		try (Socket socket = this.serverSocket.accept()) {
			release.await(10, TimeUnit.SECONDS);
		}
		catch (IOException | InterruptedException ex) {
			// closed by the test
		}
	}

	/** Reads the request, waits for the test, then answers 500. */
	private static void answerAfter(Socket socket, CountDownLatch release) {
		try (socket) {
			readRequest(socket.getInputStream());
			release.await(10, TimeUnit.SECONDS);
			OutputStream out = socket.getOutputStream();
			byte[] body = "{\"error\":\"INTERNAL_ERROR\",\"message\":\"x\"}".getBytes(StandardCharsets.UTF_8);
			out.write(("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: "
					+ body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
			out.write(body);
			out.flush();
		}
		catch (IOException | InterruptedException ex) {
			// closed by the test
		}
	}

	private static void readRequest(InputStream in) throws IOException {
		StringBuilder head = new StringBuilder();
		while (!head.toString().endsWith("\r\n\r\n")) {
			int b = in.read();
			if (b < 0) {
				return;
			}
			head.append((char) b);
		}
		String lower = head.toString().toLowerCase();
		int index = lower.indexOf("content-length:");
		if (index >= 0) {
			int end = lower.indexOf("\r\n", index);
			in.readNBytes(Integer.parseInt(lower.substring(index + 15, end).trim()));
		}
	}

	private static Reason reasonOf(AnalysisServiceClient client) {
		try {
			client.post(Endpoint.BUILDING_STATS, BODY);
			return null;
		}
		catch (AnalysisServiceException ex) {
			return ex.getReason();
		}
	}

	private static void waitUntil(java.util.function.BooleanSupplier condition) throws InterruptedException {
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
		while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
			Thread.sleep(10);
		}
		assertThat(condition.getAsBoolean()).isTrue();
	}

	private static void assertReason(Runnable call, Reason reason) {
		assertThatExceptionOfType(AnalysisServiceException.class).isThrownBy(call::run)
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(reason));
	}

}
