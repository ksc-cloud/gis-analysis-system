package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatIllegalStateException;

import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

class GeometryJsonTests {

	private final GeometryJson geometryJson = new GeometryJson(JsonMapper.builder().build());

	/** Outer ring with one hole, plus a second part; 7 decimal coordinates like the live result. */
	static List<double[][][]> buildingWithHoleAndTwoParts() {
		double[][][] withHole = {
				{ { 126.9775001, 37.5660001 }, { 126.9784999, 37.5660001 }, { 126.9784999, 37.5669999 },
						{ 126.9775001, 37.5669999 }, { 126.9775001, 37.5660001 } },
				{ { 126.9778123, 37.5663456 }, { 126.9781877, 37.5663456 }, { 126.9781877, 37.5666544 },
						{ 126.9778123, 37.5663456 } } };
		double[][][] secondPart = { { { 126.9790000, 37.5670000 }, { 126.9791234, 37.5670000 },
				{ 126.9791234, 37.5671234 }, { 126.9790000, 37.5670000 } } };
		return List.of(withHole, secondPart);
	}

	@Test
	void roundTripKeepsHolesPartsAndEveryDigit() {
		List<double[][][]> polygons = buildingWithHoleAndTwoParts();

		String json = this.geometryJson.write(polygons);
		List<double[][][]> restored = this.geometryJson.read(json);

		assertThat(json).startsWith("{\"type\":\"MultiPolygon\",\"coordinates\":[[[[126.9775001,37.5660001]")
			.contains("[126.9778123,37.5663456]")
			.contains("[126.9791234,37.5671234]");
		assertThat(restored).hasSize(2);
		assertThat(restored.get(0)).hasNumberOfRows(2);
		for (int i = 0; i < polygons.size(); i++) {
			assertThat(Arrays.deepEquals(restored.get(i), polygons.get(i))).isTrue();
		}
	}

	@Test
	void roundTripIsExactForManyRoundedCoordinates() {
		double[][] ring = new double[2001][];
		for (int i = 0; i < 2000; i++) {
			double lon = Math.round((124.0 + i * 0.0037123457) * 1e7) / 1e7;
			double lat = Math.round((33.0 + i * 0.0029876543) * 1e7) / 1e7;
			ring[i] = new double[] { lon, lat };
		}
		ring[2000] = ring[0];
		List<double[][][]> polygons = List.<double[][][]>of(new double[][][] { ring });

		List<double[][][]> restored = this.geometryJson.read(this.geometryJson.write(polygons));

		assertThat(Arrays.deepEquals(restored.get(0), polygons.get(0))).isTrue();
	}

	@Test
	void rejectsMissingPolygons() {
		assertThatIllegalArgumentException().isThrownBy(() -> this.geometryJson.write(List.of()));
		assertThatIllegalArgumentException().isThrownBy(() -> this.geometryJson.write(null));
	}

	@Test
	void rejectsStoredValuesThatAreNotMultiPolygons() {
		String[] invalid = { "{\"type\":\"Polygon\",\"coordinates\":[[[1,2],[3,4],[5,6],[1,2]]]}",
				"{\"type\":\"MultiPolygon\",\"coordinates\":[]}", "{\"type\":\"MultiPolygon\",\"coordinates\":[[]]}",
				"{\"type\":\"MultiPolygon\",\"coordinates\":[[[[1,2],[3,4],[1,2]]]]}",
				"{\"type\":\"MultiPolygon\",\"coordinates\":[[[[1,2],[3,4],[5,6],[1,\"x\"]]]]}",
				"{\"type\":\"MultiPolygon\",\"coordinates\":[[[[1,2,3],[3,4],[5,6],[1,2]]]]}", "{}" };
		for (String json : invalid) {
			assertThatIllegalStateException().as(json).isThrownBy(() -> this.geometryJson.read(json));
		}
	}

}
