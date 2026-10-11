package com.example.gis_analysis_system.web;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Limits request bodies of /api/analyses (a save request is only a token and a title). A declared Content-Length
 * over the limit is answered with 413 right away; a body without a length (chunked) fails with
 * {@link PayloadTooLargeException} as soon as it passes the limit, which the controller also maps to 413.
 */
@Component
public class AnalysisRequestSizeFilter extends OncePerRequestFilter {

	public static final int MAX_BODY_BYTES = 16 * 1024;

	private static final String PATH = "/api/analyses";

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		String path = request.getRequestURI().substring(request.getContextPath().length());
		return !(path.equals(PATH) || path.startsWith(PATH + "/"));
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		if (request.getContentLengthLong() > MAX_BODY_BYTES) {
			response.setStatus(HttpStatus.CONTENT_TOO_LARGE.value());
			response.setContentType(MediaType.APPLICATION_JSON_VALUE);
			response.setCharacterEncoding(StandardCharsets.UTF_8.name());
			response.getWriter().write(PayloadTooLargeException.JSON);
			return;
		}
		chain.doFilter(new LimitedRequest(request), response);
	}

	/** Thrown while reading a body that turns out to be larger than {@link #MAX_BODY_BYTES}. */
	public static class PayloadTooLargeException extends IOException {

		static final String MESSAGE = "요청 본문은 " + (MAX_BODY_BYTES / 1024) + "KB를 넘을 수 없습니다.";

		static final String JSON = "{\"error\":\"PAYLOAD_TOO_LARGE\",\"message\":\"" + MESSAGE + "\"}";

		PayloadTooLargeException() {
			super(MESSAGE);
		}

	}

	private static final class LimitedRequest extends HttpServletRequestWrapper {

		private ServletInputStream stream;

		LimitedRequest(HttpServletRequest request) {
			super(request);
		}

		@Override
		public ServletInputStream getInputStream() throws IOException {
			if (this.stream == null) {
				this.stream = new LimitedInputStream(super.getInputStream());
			}
			return this.stream;
		}

	}

	private static final class LimitedInputStream extends ServletInputStream {

		private final ServletInputStream delegate;

		private long read;

		LimitedInputStream(ServletInputStream delegate) {
			this.delegate = delegate;
		}

		@Override
		public int read() throws IOException {
			int b = this.delegate.read();
			if (b != -1) {
				count(1);
			}
			return b;
		}

		@Override
		public int read(byte[] buffer, int offset, int length) throws IOException {
			int n = this.delegate.read(buffer, offset, length);
			if (n > 0) {
				count(n);
			}
			return n;
		}

		private void count(int n) throws IOException {
			this.read += n;
			if (this.read > MAX_BODY_BYTES) {
				throw new PayloadTooLargeException();
			}
		}

		@Override
		public boolean isFinished() {
			return this.delegate.isFinished();
		}

		@Override
		public boolean isReady() {
			return this.delegate.isReady();
		}

		@Override
		public void setReadListener(ReadListener listener) {
			this.delegate.setReadListener(listener);
		}

	}

}
