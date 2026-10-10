package com.example.gis_analysis_system.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.example.gis_analysis_system.analysis.PlanarGeometry.Evaluation;
import com.example.gis_analysis_system.analysis.PlanarGeometry.LocalProjection;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;

/**
 * Shapes are built in meters around the center (x east, y north) and converted to WGS84 with the inverse of
 * the same projection, so the expected distances are exact up to floating point error.
 */
class PlanarGeometryTests {

	private static final double LON = 126.978;

	private static final double LAT = 37.5665;

	private final LocalProjection projection = new LocalProjection(LON, LAT);

	@Test
	void projectionMatchesGeodesicDistanceWithinOneKilometer() {
		// Reference: Vincenty inverse on the WGS84 ellipsoid.
		double[][] offsets = { { 0.0113, 0 }, { 0, 0.009 }, { -0.0080, 0.0064 }, { 0.0080, -0.0064 },
				{ -0.0113, -0.0001 }, { 0.0002, -0.009 } };
		for (double[] offset : offsets) {
			double lon = LON + offset[0];
			double lat = LAT + offset[1];
			double planar = Math.hypot(this.projection.x(lon), this.projection.y(lat));
			double geodesic = vincenty(LON, LAT, lon, lat);
			assertThat(geodesic).isBetween(700.0, 1100.0);
			assertThat(Math.abs(planar - geodesic) / geodesic).as("relative error at %s", geodesic).isLessThan(2e-4);
		}
	}

	@Test
	void polygonEntirelyWithinTheCircleIsInside() {
		Evaluation result = evaluate(300, square(200, 0, 25));

		assertThat(result.relation()).isEqualTo(Relation.INSIDE);
		assertThat(result.distanceMeters()).isCloseTo(175, within(1e-6));
		assertThat(result.centerInside()).isFalse();
	}

	@Test
	void polygonCrossingTheCircleIsPartial() {
		Evaluation result = evaluate(100, square(100, 0, 25));

		assertThat(result.relation()).isEqualTo(Relation.PARTIAL);
		assertThat(result.distanceMeters()).isCloseTo(75, within(1e-6));
	}

	@Test
	void polygonBeyondTheCircleIsOutside() {
		Evaluation result = evaluate(100, square(200, 0, 25));

		assertThat(result.relation()).isEqualTo(Relation.OUTSIDE);
		assertThat(result.distanceMeters()).isCloseTo(175, within(1e-6));
	}

	@Test
	void polygonTouchingTheCircleCountsAsPartial() {
		// Nearest edge at exactly x = 100 m.
		assertThat(evaluate(100, rect(100, -10, 120, 10)).relation()).isEqualTo(Relation.PARTIAL);
		assertThat(evaluate(100, rect(100.01, -10, 120, 10)).relation()).isEqualTo(Relation.OUTSIDE);
		// A vertex exactly on the circle while the rest is inside is still inside.
		assertThat(evaluate(100, rect(0, 0, 60, 80)).relation()).isEqualTo(Relation.INSIDE);
		assertThat(evaluate(100, rect(0, 0, 60, 80.1)).relation()).isEqualTo(Relation.PARTIAL);
	}

	@Test
	void nearestPointCanBeAVertex() {
		Evaluation result = evaluate(1000, rect(30, 40, 60, 80));

		assertThat(result.distanceMeters()).isCloseTo(50, within(1e-6));
	}

	@Test
	void centerInsideTheBuildingHasZeroDistance() {
		Evaluation small = evaluate(100, square(5, 5, 20));
		Evaluation enclosing = evaluate(100, square(0, 0, 500));

		assertThat(small.relation()).isEqualTo(Relation.INSIDE);
		assertThat(small.distanceMeters()).isZero();
		assertThat(small.centerInside()).isTrue();
		// A footprint that encloses the whole circle intersects it without being inside it.
		assertThat(enclosing.relation()).isEqualTo(Relation.PARTIAL);
		assertThat(enclosing.distanceMeters()).isZero();
	}

	@Test
	void centerInAHoleIsOutsideTheBuilding() {
		double[][][] courtyard = withHole(square(0, 0, 200), square(0, 0, 50));

		Evaluation smallCircle = evaluate(30, courtyard);
		Evaluation largerCircle = evaluate(60, courtyard);

		// The circle lies entirely within the courtyard.
		assertThat(smallCircle.relation()).isEqualTo(Relation.OUTSIDE);
		assertThat(smallCircle.centerInside()).isFalse();
		assertThat(smallCircle.distanceMeters()).isCloseTo(50, within(1e-6));
		assertThat(largerCircle.relation()).isEqualTo(Relation.PARTIAL);
		assertThat(largerCircle.distanceMeters()).isCloseTo(50, within(1e-6));
	}

	@Test
	void holesDoNotPreventInside() {
		double[][][] building = withHole(square(100, 0, 20), square(100, 0, 5));

		Evaluation result = evaluate(200, building);

		assertThat(result.relation()).isEqualTo(Relation.INSIDE);
		assertThat(result.distanceMeters()).isCloseTo(80, within(1e-6));
	}

	@Test
	void concaveNotchAroundTheCenterIsNotInside() {
		// U shape open to the north; the center sits in the notch.
		double[][] u = { { -30, -30 }, { 30, -30 }, { 30, 30 }, { 10, 30 }, { 10, -10 }, { -10, -10 }, { -10, 30 },
				{ -30, 30 }, { -30, -30 } };

		Evaluation result = evaluate(100, new double[][][] { toLonLat(u) });

		assertThat(result.centerInside()).isFalse();
		assertThat(result.distanceMeters()).isCloseTo(10, within(1e-6));
		assertThat(result.relation()).isEqualTo(Relation.INSIDE);
	}

	@Test
	void multiPolygonUsesAllParts() {
		double[][][] near = square(50, 0, 10);
		double[][][] far = square(500, 0, 10);
		double[][][] crossing = square(100, 0, 10);

		Evaluation allInside = evaluate(200, near, square(-50, 0, 10));
		Evaluation oneFar = evaluate(200, far, near);
		Evaluation oneCrossing = evaluate(200, near, square(200, 0, 10));
		Evaluation allOutside = evaluate(60, far, crossing);

		assertThat(allInside.relation()).isEqualTo(Relation.INSIDE);
		assertThat(oneFar.relation()).isEqualTo(Relation.PARTIAL);
		assertThat(oneFar.distanceMeters()).isCloseTo(40, within(1e-6));
		assertThat(oneCrossing.relation()).isEqualTo(Relation.PARTIAL);
		assertThat(allOutside.relation()).isEqualTo(Relation.OUTSIDE);
		assertThat(allOutside.distanceMeters()).isCloseTo(90, within(1e-6));
	}

	@Test
	void ringContainsUsesEvenOddRule() {
		double[][] ring = { { 0, 0 }, { 10, 0 }, { 10, 10 }, { 0, 10 }, { 0, 0 } };

		assertThat(PlanarGeometry.ringContains(ring, 5, 5)).isTrue();
		assertThat(PlanarGeometry.ringContains(ring, 15, 5)).isFalse();
		assertThat(PlanarGeometry.distanceToSegment(5, 5, 0, 0, 10, 0)).isEqualTo(5);
		assertThat(PlanarGeometry.distanceToSegment(-3, 4, 0, 0, 10, 0)).isEqualTo(5);
		assertThat(PlanarGeometry.distanceToSegment(1, 1, 0, 0, 0, 0)).isCloseTo(Math.sqrt(2), within(1e-12));
	}

	private Evaluation evaluate(double radius, double[][][]... polygons) {
		return PlanarGeometry.evaluate(List.of(polygons), this.projection, radius);
	}

	private double[][][] square(double cx, double cy, double half) {
		return rect(cx - half, cy - half, cx + half, cy + half);
	}

	private double[][][] rect(double minX, double minY, double maxX, double maxY) {
		double[][] ring = { { minX, minY }, { maxX, minY }, { maxX, maxY }, { minX, maxY }, { minX, minY } };
		return new double[][][] { toLonLat(ring) };
	}

	private static double[][][] withHole(double[][][] outer, double[][][] hole) {
		return new double[][][] { outer[0], reverse(hole[0]) };
	}

	private static double[][] reverse(double[][] ring) {
		double[][] reversed = new double[ring.length][];
		for (int i = 0; i < ring.length; i++) {
			reversed[i] = ring[ring.length - 1 - i];
		}
		return reversed;
	}

	private double[][] toLonLat(double[][] ringMeters) {
		double[][] ring = new double[ringMeters.length][];
		for (int i = 0; i < ringMeters.length; i++) {
			ring[i] = new double[] { this.projection.lon(ringMeters[i][0]), this.projection.lat(ringMeters[i][1]) };
		}
		return ring;
	}

	/** Vincenty inverse formula (WGS84), distance in meters. */
	private static double vincenty(double lon1, double lat1, double lon2, double lat2) {
		double a = 6378137.0;
		double f = 1 / 298.257223563;
		double b = a * (1 - f);
		double l = Math.toRadians(lon2 - lon1);
		double u1 = Math.atan((1 - f) * Math.tan(Math.toRadians(lat1)));
		double u2 = Math.atan((1 - f) * Math.tan(Math.toRadians(lat2)));
		double sinU1 = Math.sin(u1);
		double cosU1 = Math.cos(u1);
		double sinU2 = Math.sin(u2);
		double cosU2 = Math.cos(u2);
		double lambda = l;
		double sinSigma;
		double cosSigma;
		double sigma;
		double cosSqAlpha;
		double cos2SigmaM;
		double previous;
		int iterations = 0;
		do {
			double sinLambda = Math.sin(lambda);
			double cosLambda = Math.cos(lambda);
			sinSigma = Math.sqrt(Math.pow(cosU2 * sinLambda, 2)
					+ Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosLambda, 2));
			cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
			sigma = Math.atan2(sinSigma, cosSigma);
			double sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
			cosSqAlpha = 1 - sinAlpha * sinAlpha;
			cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
			double c = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
			previous = lambda;
			lambda = l + (1 - c) * f * sinAlpha
					* (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
		}
		while (Math.abs(lambda - previous) > 1e-12 && ++iterations < 200);
		double uSq = cosSqAlpha * (a * a - b * b) / (b * b);
		double bigA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
		double bigB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
		double deltaSigma = bigB * sinSigma * (cos2SigmaM + bigB / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
				- bigB / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
		return b * bigA * (sigma - deltaSigma);
	}

}
