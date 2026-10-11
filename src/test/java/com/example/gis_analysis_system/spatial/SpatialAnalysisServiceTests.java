package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.willThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import com.example.gis_analysis_system.history.AnalysisHistoryException;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.history.AnalysisSnapshot;
import com.example.gis_analysis_system.history.AnalysisSnapshotStore;
import com.example.gis_analysis_system.spatial.AnalysisServiceClient.Endpoint;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.SpatialAnalysisResponse;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class SpatialAnalysisServiceTests {

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	private final AnalysisHistoryService history = mock(AnalysisHistoryService.class);

	private final AnalysisSnapshotStore store = new AnalysisSnapshotStore();

	private final AnalysisServiceClient client = mock(AnalysisServiceClient.class);

	private SpatialAnalysisService service;

	@BeforeEach
	void setUp() {
		this.service = new SpatialAnalysisService(this.history, this.store, new PythonRequestMapper(this.jsonMapper),
				this.client);
		given(this.client.isConfigured()).willReturn(true);
		given(this.client.post(eq(Endpoint.BUILDING_STATS), any()))
			.willReturn(this.jsonMapper.readTree(SpatialFixtures.buildingStatsResponse()));
		given(this.client.post(eq(Endpoint.GRID_DENSITY), any()))
			.willReturn(this.jsonMapper.readTree(SpatialFixtures.gridDensityResponse()));
		given(this.client.post(eq(Endpoint.COMPARE), any()))
			.willReturn(this.jsonMapper.readTree(SpatialFixtures.compareResponse(true)));
		given(this.client.post(eq(Endpoint.HOTSPOT), any()))
			.willReturn(this.jsonMapper.readTree(SpatialFixtures.hotspotResponse(SpatialFixtures.HOTSPOT_OK)));
	}

	// ----------------------------------------------------------------- saved analyses

	@Test
	void savedStatisticsSendsTheSavedAnalysis() {
		AnalysisDetail detail = SpatialFixtures.detail(12, "2026-10-11T03:00:00Z", SpatialFixtures.liveResult());
		given(this.history.get(12)).willReturn(detail);

		SpatialAnalysisResponse response = this.service.savedStatistics(12, true);

		assertThat(response.analysisIds()).containsExactly(12L);
		assertThat(response.analysisService().schemaVersion()).isEqualTo(1);
		assertThat(response.result().get("counts").get("analyzed").asInt()).isEqualTo(1);
		JsonNode sent = sent(Endpoint.BUILDING_STATS);
		assertThat(sent.get("source").get("kind").asString()).isEqualTo("SAVED");
		assertThat(sent.get("source").get("analysisId").asLong()).isEqualTo(12);
		assertThat(sent.get("source").get("analyzedAt").asString()).isEqualTo("2026-10-11T03:00:00Z");
		assertThat(sent.get("includeBuildings").asBoolean()).isTrue();
	}

	@Test
	void savedGridDensityPassesTheOptions() {
		AnalysisDetail detail = SpatialFixtures.detail(12, "2026-10-11T03:00:00Z", SpatialFixtures.liveResult());
		given(this.history.get(12)).willReturn(detail);

		this.service.savedGridDensity(12, 200, false, true);

		JsonNode sent = sent(Endpoint.GRID_DENSITY);
		assertThat(sent.get("cellSizeMeters").asInt()).isEqualTo(200);
		assertThat(sent.get("includeEmptyCells").asBoolean()).isFalse();
		assertThat(sent.get("includeCellBuildingIds").asBoolean()).isTrue();
	}

	@Test
	void invalidCellSizeIsRejectedBeforeAnything() {
		assertThatExceptionOfType(InvalidSpatialRequestException.class)
			.isThrownBy(() -> this.service.savedGridDensity(12, 75, true, false))
			.satisfies((ex) -> assertThat(ex.getError()).isEqualTo("INVALID_CELL_SIZE"));
		verifyNoInteractions(this.history);
		verify(this.client, never()).post(any(), any());
	}

	// ----------------------------------------------------------------- hotspot

	@Test
	void savedHotspotSendsTheAnalysisWithTheCellSize() {
		AnalysisDetail detail = SpatialFixtures.detail(12, "2026-10-11T03:00:00Z", SpatialFixtures.syntheticResult(3, 0));
		given(this.history.get(12)).willReturn(detail);

		SpatialAnalysisResponse response = this.service.savedHotspot(12, 50);

		assertThat(response.analysisIds()).containsExactly(12L);
		assertThat(response.analysisService().schemaVersion()).isEqualTo(1);
		assertThat(response.result().get("status").asString()).isEqualTo("OK");
		JsonNode sent = sent(Endpoint.HOTSPOT);
		assertThat(sent.get("cellSizeMeters").asInt()).isEqualTo(50);
		assertThat(sent.get("source").get("kind").asString()).isEqualTo("SAVED");
		assertThat(sent.get("source").get("analysisId").asLong()).isEqualTo(12);
		assertThat(sent.get("complete").asBoolean()).isTrue();
		assertThat(sent.has("permutations") || sent.has("seed") || sent.has("includeEmptyCells")).isFalse();
		InOrder order = inOrder(this.client, this.history);
		order.verify(this.client).requireAvailable();
		order.verify(this.history).get(12);
		order.verify(this.client).post(eq(Endpoint.HOTSPOT), any());
	}

	@Test
	void partialAnalysisIsSentAndTheBlockedResultReturnedAsItIs() {
		JsonNode blocked = this.jsonMapper.readTree(SpatialFixtures.hotspotResponse(SpatialFixtures.HOTSPOT_BLOCKED));
		given(this.client.post(eq(Endpoint.HOTSPOT), any())).willReturn(blocked);
		// liveResult() stubs its own mocks: build it before stubbing the history.
		AnalysisDetail partial = SpatialFixtures.detail(12, "2026-10-11T03:00:00Z", SpatialFixtures.liveResult());
		given(this.history.get(12)).willReturn(partial);

		SpatialAnalysisResponse response = this.service.savedHotspot(12, 100);

		JsonNode sent = sent(Endpoint.HOTSPOT);
		assertThat(sent.get("complete").asBoolean()).isFalse();
		assertThat(sent.get("incompleteReasons").get(0).get("code").asString()).isEqualTo("PAGE_LIMIT");
		assertThat(response.result()).isSameAs(blocked);
		assertThat(response.result().get("status").asString()).isEqualTo("PARTIAL_RESULT_BLOCKED");
		assertThat(response.analysisIds()).containsExactly(12L);
	}

	@Test
	void snapshotHotspotIsSentAsLive() {
		AnalysisSnapshot snapshot = this.store.put(SpatialFixtures.liveResult());

		SpatialAnalysisResponse response = this.service.snapshotHotspot(snapshot.token().toString(), 200);

		assertThat(response.analysisIds()).isEmpty();
		JsonNode sent = sent(Endpoint.HOTSPOT);
		assertThat(sent.get("source").get("kind").asString()).isEqualTo("LIVE");
		assertThat(sent.get("source").get("analysisId").isNull()).isTrue();
		assertThat(sent.get("cellSizeMeters").asInt()).isEqualTo(200);
		assertThat(sent.get("complete").asBoolean()).isFalse();
		assertThat(this.store.find(snapshot.token())).contains(snapshot);
	}

	@Test
	void hotspotRejectsAnInvalidCellSizeBeforeAnything() {
		for (Runnable call : new Runnable[] { () -> this.service.savedHotspot(12, 75),
				() -> this.service.snapshotHotspot(UUID.randomUUID().toString(), 150) }) {
			assertThatExceptionOfType(InvalidSpatialRequestException.class).isThrownBy(call::run)
				.satisfies((ex) -> assertThat(ex.getError()).isEqualTo("INVALID_CELL_SIZE"));
		}
		verifyNoInteractions(this.history);
		verify(this.client, never()).requireAvailable();
		verify(this.client, never()).post(any(), any());
	}

	@Test
	void hotspotKeepsTheAvailabilityAndLookupRules() {
		given(this.history.get(99)).willThrow(new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "없음"));
		assertThatExceptionOfType(AnalysisHistoryException.class).isThrownBy(() -> this.service.savedHotspot(99, 100))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.ANALYSIS_NOT_FOUND));
		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.snapshotHotspot(UUID.randomUUID().toString(), 100))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.SNAPSHOT_EXPIRED));
		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.snapshotHotspot("not-a-token", 100))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.INVALID_TOKEN));
		verify(this.client, never()).post(any(), any());

		willThrow(new AnalysisServiceException(Reason.ANALYSIS_SERVICE_UNAVAILABLE, "x")).given(this.client)
			.requireAvailable();
		AnalysisSnapshotStore store = mock(AnalysisSnapshotStore.class);
		SpatialAnalysisService service = new SpatialAnalysisService(this.history, store,
				new PythonRequestMapper(this.jsonMapper), this.client);
		assertThatExceptionOfType(AnalysisServiceException.class).isThrownBy(() -> service.savedHotspot(12, 100));
		assertThatExceptionOfType(AnalysisServiceException.class)
			.isThrownBy(() -> service.snapshotHotspot(UUID.randomUUID().toString(), 100));
		verify(this.history).get(99);
		verify(this.history, never()).get(12);
		verifyNoInteractions(store);
	}

	@Test
	void pythonUnavailableSkipsTheDatabase() {
		willThrow(new AnalysisServiceException(Reason.ANALYSIS_SERVICE_UNAVAILABLE, "x")).given(this.client)
			.requireAvailable();

		assertThatExceptionOfType(AnalysisServiceException.class).isThrownBy(() -> this.service.savedStatistics(12, false));
		assertThatExceptionOfType(AnalysisServiceException.class)
			.isThrownBy(() -> this.service.comparison(12, 15, false, true));
		verifyNoInteractions(this.history);
	}

	@Test
	void missingAnalysisIsNotFound() {
		given(this.history.get(99)).willThrow(new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "없음"));

		assertThatExceptionOfType(AnalysisHistoryException.class).isThrownBy(() -> this.service.savedStatistics(99, false))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.ANALYSIS_NOT_FOUND));
		verify(this.client, never()).post(any(), any());
	}

	// ----------------------------------------------------------------- comparison

	@Test
	void olderAnalysisIsBeforeWhateverTheOrderOfIds() {
		// id 15 was analysed first.
		given(this.history.get(12)).willReturn(SpatialFixtures.detail(12, "2026-09-01T00:00:00Z",
				SpatialFixtures.syntheticResult(3, 1)));
		given(this.history.get(15)).willReturn(SpatialFixtures.detail(15, "2026-03-01T00:00:00Z",
				SpatialFixtures.syntheticResult(3, 0)));

		SpatialAnalysisResponse forward = this.service.comparison(12, 15, false, true);
		JsonNode first = sent(Endpoint.COMPARE);

		assertThat(forward.analysisIds()).containsExactly(15L, 12L);
		assertThat(first.get("before").get("source").get("analysisId").asLong()).isEqualTo(15);
		assertThat(first.get("after").get("source").get("analysisId").asLong()).isEqualTo(12);
		assertThat(first.get("before").get("source").get("analyzedAt").asString()).isEqualTo("2026-03-01T00:00:00Z");
		assertThat(this.service.comparison(15, 12, false, true).analysisIds()).containsExactly(15L, 12L);
	}

	@Test
	void sameTimeIsOrderedById() {
		given(this.history.get(12)).willReturn(SpatialFixtures.detail(12, "2026-09-01T00:00:00Z",
				SpatialFixtures.syntheticResult(2, 0)));
		given(this.history.get(15)).willReturn(SpatialFixtures.detail(15, "2026-09-01T00:00:00Z",
				SpatialFixtures.syntheticResult(2, 0)));

		assertThat(this.service.comparison(15, 12, true, false).analysisIds()).containsExactly(12L, 15L);
		JsonNode sent = sent(Endpoint.COMPARE);
		assertThat(sent.get("includeUnchanged").asBoolean()).isTrue();
		assertThat(sent.get("includeBuildingChanges").asBoolean()).isFalse();
	}

	@Test
	void sameAnalysisIsRejectedBeforePython() {
		assertThatExceptionOfType(InvalidSpatialRequestException.class)
			.isThrownBy(() -> this.service.comparison(12, 12, false, true))
			.satisfies((ex) -> assertThat(ex.getError()).isEqualTo("SAME_ANALYSIS"));
		verifyNoInteractions(this.history);
		verify(this.client, never()).post(any(), any());
		verify(this.client, never()).requireAvailable();
	}

	// ----------------------------------------------------------------- snapshots

	@Test
	void snapshotIsSentAsLiveAndStaysSavable() {
		AnalysisSnapshot snapshot = this.store.put(SpatialFixtures.liveResult());

		SpatialAnalysisResponse response = this.service.snapshotStatistics(snapshot.token().toString().toUpperCase(),
				false);

		assertThat(response.analysisIds()).isEmpty();
		JsonNode sent = sent(Endpoint.BUILDING_STATS);
		assertThat(sent.get("source").get("kind").asString()).isEqualTo("LIVE");
		assertThat(sent.get("source").get("analysisId").isNull()).isTrue();
		assertThat(sent.get("source").get("analyzedAt").asString()).isEqualTo(snapshot.analyzedAt().toString());
		// Reading a snapshot does not consume it: it can still be saved.
		assertThat(this.store.find(snapshot.token())).contains(snapshot);

		this.service.snapshotGridDensity(snapshot.token().toString(), 50, true, false);
		assertThat(sent(Endpoint.GRID_DENSITY).get("source").get("kind").asString()).isEqualTo("LIVE");
	}

	@Test
	void malformedTokenIsInvalidAndUnknownTokenIsExpired() {
		String unknown = UUID.randomUUID().toString();

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.snapshotStatistics("not-a-token", false))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.INVALID_TOKEN));
		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.snapshotGridDensity(unknown, 100, true, false))
			.satisfies((ex) -> {
				assertThat(ex.getCode()).isEqualTo(Code.SNAPSHOT_EXPIRED);
				assertThat(ex.getMessage()).doesNotContain(unknown);
			});
		verify(this.client, never()).post(any(), any());
	}

	@Test
	void snapshotChecksPythonBeforeTheStore() {
		AnalysisSnapshotStore store = mock(AnalysisSnapshotStore.class);
		SpatialAnalysisService service = new SpatialAnalysisService(this.history, store,
				new PythonRequestMapper(this.jsonMapper), this.client);
		willThrow(new AnalysisServiceException(Reason.ANALYSIS_SERVICE_NOT_CONFIGURED, "x")).given(this.client)
			.requireAvailable();

		assertThatExceptionOfType(AnalysisServiceException.class)
			.isThrownBy(() -> service.snapshotStatistics(UUID.randomUUID().toString(), false));
		verifyNoInteractions(store);
	}

	// ----------------------------------------------------------------- status

	@Test
	void statusReportsConfiguredAndAvailable() {
		given(this.client.isAvailable()).willReturn(true);
		assertThat(this.service.status()).isEqualTo(new SpatialAnalysisService.ServiceStatus(true, true));

		given(this.client.isAvailable()).willReturn(false);
		assertThat(this.service.status()).isEqualTo(new SpatialAnalysisService.ServiceStatus(false, true));

		given(this.client.isConfigured()).willReturn(false);
		assertThat(this.service.status()).isEqualTo(new SpatialAnalysisService.ServiceStatus(false, false));
	}

	@Test
	void availabilityIsCheckedBeforeLoading() {
		AnalysisDetail detail = SpatialFixtures.detail(12, "2026-10-11T03:00:00Z", SpatialFixtures.liveResult());
		given(this.history.get(anyLong())).willReturn(detail);

		this.service.savedStatistics(12, false);

		InOrder order = inOrder(this.client, this.history);
		order.verify(this.client).requireAvailable();
		order.verify(this.history).get(12);
		order.verify(this.client).post(eq(Endpoint.BUILDING_STATS), any());
	}

	private JsonNode sent(Endpoint endpoint) {
		ArgumentCaptor<byte[]> body = ArgumentCaptor.forClass(byte[].class);
		verify(this.client, org.mockito.Mockito.atLeastOnce()).post(eq(endpoint), body.capture());
		return this.jsonMapper.readTree(body.getValue());
	}

}
