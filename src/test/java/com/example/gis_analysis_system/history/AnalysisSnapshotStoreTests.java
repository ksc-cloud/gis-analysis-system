package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;

class AnalysisSnapshotStoreTests {

	private final MutableClock clock = new MutableClock(Instant.parse("2026-10-11T03:00:00.123456Z"));

	private final AnalysisSnapshotStore store = new AnalysisSnapshotStore(this.clock);

	@Test
	void issuesRandomTokensWithMillisecondTimes() {
		RadiusAnalysisResult result = mock(RadiusAnalysisResult.class);

		AnalysisSnapshot snapshot = this.store.put(result);

		assertThat(snapshot.token().version()).isEqualTo(4);
		assertThat(snapshot.result()).isSameAs(result);
		assertThat(snapshot.analyzedAt()).isEqualTo(Instant.parse("2026-10-11T03:00:00.123Z"));
		assertThat(snapshot.expiresAt()).isEqualTo(snapshot.analyzedAt().plus(AnalysisSnapshotStore.TTL));
		assertThat(this.store.find(snapshot.token())).containsSame(snapshot);
		assertThat(this.store.find(UUID.randomUUID())).isEmpty();
	}

	@Test
	void expiresAfterThirtyMinutes() {
		AnalysisSnapshot snapshot = this.store.put(mock(RadiusAnalysisResult.class));

		this.clock.advance(Duration.ofMinutes(30).minusMillis(1));
		assertThat(this.store.find(snapshot.token())).isPresent();

		this.clock.advance(Duration.ofMillis(1));
		assertThat(this.store.find(snapshot.token())).isEmpty();
		assertThat(this.store.size()).isZero();
	}

	@Test
	void keepsOnlyTheNewestTen() {
		List<AnalysisSnapshot> snapshots = new ArrayList<>();
		for (int i = 0; i < AnalysisSnapshotStore.MAX_SNAPSHOTS + 2; i++) {
			snapshots.add(this.store.put(mock(RadiusAnalysisResult.class)));
			this.clock.advance(Duration.ofSeconds(1));
		}

		assertThat(this.store.size()).isEqualTo(AnalysisSnapshotStore.MAX_SNAPSHOTS);
		assertThat(this.store.find(snapshots.get(0).token())).isEmpty();
		assertThat(this.store.find(snapshots.get(1).token())).isEmpty();
		for (AnalysisSnapshot kept : snapshots.subList(2, snapshots.size())) {
			assertThat(this.store.find(kept.token())).containsSame(kept);
		}
	}

	@Test
	void expiredEntriesDoNotPushOutFreshOnes() {
		for (int i = 0; i < AnalysisSnapshotStore.MAX_SNAPSHOTS; i++) {
			this.store.put(mock(RadiusAnalysisResult.class));
		}
		this.clock.advance(Duration.ofMinutes(31));

		AnalysisSnapshot fresh = this.store.put(mock(RadiusAnalysisResult.class));

		assertThat(this.store.size()).isEqualTo(1);
		assertThat(this.store.find(fresh.token())).containsSame(fresh);
	}

	@Test
	void removeDeletesOnlyThatSnapshot() {
		AnalysisSnapshot first = this.store.put(mock(RadiusAnalysisResult.class));
		AnalysisSnapshot second = this.store.put(mock(RadiusAnalysisResult.class));

		this.store.remove(first);
		this.store.remove(first);
		this.store.remove(new AnalysisSnapshot(second.token(), mock(RadiusAnalysisResult.class), second.analyzedAt(),
				second.expiresAt()));

		assertThat(this.store.find(first.token())).isEmpty();
		assertThat(this.store.find(second.token())).containsSame(second);
	}

	@Test
	void staysConsistentUnderConcurrentUse() throws Exception {
		AnalysisSnapshotStore realClockStore = new AnalysisSnapshotStore();
		int threads = 8;
		int perThread = 300;
		Set<UUID> tokens = ConcurrentHashMap.newKeySet();
		CountDownLatch start = new CountDownLatch(1);
		ExecutorService executor = Executors.newFixedThreadPool(threads);
		try {
			List<Future<?>> futures = new ArrayList<>();
			for (int t = 0; t < threads; t++) {
				futures.add(executor.submit(() -> {
					start.await();
					for (int i = 0; i < perThread; i++) {
						AnalysisSnapshot snapshot = realClockStore.put(mock(RadiusAnalysisResult.class));
						tokens.add(snapshot.token());
						realClockStore.find(snapshot.token());
						if (i % 3 == 0) {
							realClockStore.remove(snapshot);
						}
						assertThat(realClockStore.size()).isLessThanOrEqualTo(AnalysisSnapshotStore.MAX_SNAPSHOTS);
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<?> future : futures) {
				future.get(60, TimeUnit.SECONDS);
			}
		}
		finally {
			executor.shutdownNow();
		}

		assertThat(tokens).hasSize(threads * perThread);
		assertThat(realClockStore.size()).isLessThanOrEqualTo(AnalysisSnapshotStore.MAX_SNAPSHOTS);
	}

	static final class MutableClock extends Clock {

		private Instant now;

		MutableClock(Instant now) {
			this.now = now;
		}

		void advance(Duration duration) {
			this.now = this.now.plus(duration);
		}

		@Override
		public ZoneId getZone() {
			return ZoneOffset.UTC;
		}

		@Override
		public Clock withZone(ZoneId zone) {
			return this;
		}

		@Override
		public Instant instant() {
			return this.now;
		}

	}

}
