package com.example.gis_analysis_system.history;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;

/**
 * In-memory store of recent radius analysis results, keyed by a random UUID token.
 * <p>
 * Bounded by count ({@value #MAX_SNAPSHOTS}, oldest dropped first) and by age ({@link #TTL}), so a 1 km result of a
 * few MB cannot pile up. Entries are lost on restart, which the save API reports as an expired token. All methods are
 * synchronized; the database's unique token constraint is the final guard against saving one result twice.
 */
@Component
public class AnalysisSnapshotStore {

	public static final Duration TTL = Duration.ofMinutes(30);

	public static final int MAX_SNAPSHOTS = 10;

	private final Clock clock;

	/** Insertion order = analysis order, so the first entry is always the oldest. */
	private final Map<UUID, AnalysisSnapshot> snapshots = new LinkedHashMap<>();

	@Autowired
	public AnalysisSnapshotStore() {
		this(Clock.systemUTC());
	}

	AnalysisSnapshotStore(Clock clock) {
		this.clock = clock;
	}

	public synchronized AnalysisSnapshot put(RadiusAnalysisResult result) {
		Instant now = now();
		purgeExpired(now);
		while (this.snapshots.size() >= MAX_SNAPSHOTS) {
			Iterator<UUID> oldest = this.snapshots.keySet().iterator();
			oldest.next();
			oldest.remove();
		}
		UUID token = UUID.randomUUID();
		while (this.snapshots.containsKey(token)) {
			token = UUID.randomUUID();
		}
		AnalysisSnapshot snapshot = new AnalysisSnapshot(token, result, now, now.plus(TTL));
		this.snapshots.put(token, snapshot);
		return snapshot;
	}

	/** The snapshot for the token, unless it is unknown or expired. */
	public synchronized Optional<AnalysisSnapshot> find(UUID token) {
		purgeExpired(now());
		return Optional.ofNullable(this.snapshots.get(token));
	}

	/** Removes the snapshot after it was saved; does nothing if the token now points to something else. */
	public synchronized void remove(AnalysisSnapshot snapshot) {
		this.snapshots.remove(snapshot.token(), snapshot);
	}

	synchronized int size() {
		purgeExpired(now());
		return this.snapshots.size();
	}

	private void purgeExpired(Instant now) {
		this.snapshots.values().removeIf((snapshot) -> !now.isBefore(snapshot.expiresAt()));
	}

	private Instant now() {
		return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}

}
