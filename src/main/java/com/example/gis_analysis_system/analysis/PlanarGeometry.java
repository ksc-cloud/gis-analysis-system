package com.example.gis_analysis_system.analysis;

import java.util.List;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;

/**
 * Circle/footprint tests in a local plane around the analysis center.
 * <p>
 * WGS84 degrees are not lengths, so coordinates are first projected onto a plane tangent at the center
 * (x east, y north, meters) using the WGS84 meridian (M) and prime vertical (N) radii of curvature at the
 * center latitude. Within 1 km of the center the scale error stays around 0.01 % (about 10 cm at 1 km).
 * The tests are horizontal and ignore terrain.
 */
final class PlanarGeometry {

	/** Distances within 1 mm of the radius count as touching the circle. */
	static final double TOLERANCE_METERS = 1e-3;

	private static final double WGS84_A = 6378137.0;

	private static final double WGS84_F = 1 / 298.257223563;

	private static final double WGS84_E2 = WGS84_F * (2 - WGS84_F);

	private PlanarGeometry() {
	}

	/** Local tangent-plane projection with the center at (0, 0). */
	static final class LocalProjection {

		private final double lon0;

		private final double lat0;

		private final double metersPerRadianLon;

		private final double metersPerRadianLat;

		LocalProjection(double lon0, double lat0) {
			this.lon0 = lon0;
			this.lat0 = lat0;
			double phi = Math.toRadians(lat0);
			double sin = Math.sin(phi);
			double w = Math.sqrt(1 - WGS84_E2 * sin * sin);
			double n = WGS84_A / w;
			double m = WGS84_A * (1 - WGS84_E2) / (w * w * w);
			this.metersPerRadianLon = n * Math.cos(phi);
			this.metersPerRadianLat = m;
		}

		double x(double lon) {
			return Math.toRadians(lon - this.lon0) * this.metersPerRadianLon;
		}

		double y(double lat) {
			return Math.toRadians(lat - this.lat0) * this.metersPerRadianLat;
		}

		double lon(double x) {
			return this.lon0 + Math.toDegrees(x / this.metersPerRadianLon);
		}

		double lat(double y) {
			return this.lat0 + Math.toDegrees(y / this.metersPerRadianLat);
		}

		double[][] project(double[][] ringLonLat) {
			double[][] projected = new double[ringLonLat.length][];
			for (int i = 0; i < ringLonLat.length; i++) {
				projected[i] = new double[] { x(ringLonLat[i][0]), y(ringLonLat[i][1]) };
			}
			return projected;
		}

		double[][][] project(double[][][] polygonLonLat) {
			double[][][] projected = new double[polygonLonLat.length][][];
			for (int r = 0; r < polygonLonLat.length; r++) {
				projected[r] = project(polygonLonLat[r]);
			}
			return projected;
		}

	}

	/**
	 * @param relation how the building relates to the circle
	 * @param distanceMeters shortest distance from the center to the footprint (0 when the center is inside)
	 * @param centerInside whether the center is inside the footprint (not in a hole)
	 */
	record Evaluation(Relation relation, double distanceMeters, boolean centerInside) {
	}

	/**
	 * Evaluates one building made of one or more polygons ({@code rings[points[lon, lat]]}, outer ring first).
	 * <ul>
	 * <li>A polygon intersects the closed disk when its distance from the center is at most the radius. The
	 * distance is 0 when the center is inside the outer ring and not inside any hole; otherwise it is the distance
	 * to the nearest edge of any ring. This covers a footprint that encloses the circle (distance 0) and a circle
	 * that lies entirely within a hole (distance to the hole edge, larger than the radius).</li>
	 * <li>A polygon lies within the disk when every outer-ring vertex does: the disk is convex and holes only
	 * remove area.</li>
	 * <li>INSIDE when every polygon lies within the disk, PARTIAL when at least one polygon intersects it,
	 * otherwise OUTSIDE. The distance is the minimum over all polygons.</li>
	 * </ul>
	 */
	static Evaluation evaluate(List<double[][][]> polygonsLonLat, LocalProjection projection, double radius) {
		if (polygonsLonLat == null || polygonsLonLat.isEmpty()) {
			throw new IllegalArgumentException("polygons required");
		}
		double minDistance = Double.POSITIVE_INFINITY;
		boolean centerInside = false;
		boolean allWithin = true;
		for (double[][][] polygonLonLat : polygonsLonLat) {
			double[][][] polygon = projection.project(polygonLonLat);
			boolean contains = containsOrigin(polygon);
			double distance = contains ? 0 : distanceToRings(polygon);
			centerInside |= contains;
			minDistance = Math.min(minDistance, distance);
			allWithin &= outerRingWithin(polygon[0], radius);
		}
		Relation relation;
		if (allWithin) {
			relation = Relation.INSIDE;
		}
		else if (minDistance <= radius + TOLERANCE_METERS) {
			relation = Relation.PARTIAL;
		}
		else {
			relation = Relation.OUTSIDE;
		}
		return new Evaluation(relation, minDistance, centerInside);
	}

	/** Inside the outer ring and not strictly inside any hole. Points on an edge have distance 0 anyway. */
	static boolean containsOrigin(double[][][] polygon) {
		if (!ringContains(polygon[0], 0, 0)) {
			return false;
		}
		for (int r = 1; r < polygon.length; r++) {
			if (ringContains(polygon[r], 0, 0)) {
				return false;
			}
		}
		return true;
	}

	/** Even-odd ray casting for a closed ring. */
	static boolean ringContains(double[][] ring, double px, double py) {
		boolean inside = false;
		for (int i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			double xi = ring[i][0];
			double yi = ring[i][1];
			double xj = ring[j][0];
			double yj = ring[j][1];
			if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
		return inside;
	}

	static double distanceToRings(double[][][] polygon) {
		double best = Double.POSITIVE_INFINITY;
		for (double[][] ring : polygon) {
			for (int i = 1; i < ring.length; i++) {
				best = Math.min(best,
						distanceToSegment(0, 0, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]));
			}
		}
		return best;
	}

	static double distanceToSegment(double px, double py, double ax, double ay, double bx, double by) {
		double dx = bx - ax;
		double dy = by - ay;
		double lengthSquared = dx * dx + dy * dy;
		double t = (lengthSquared == 0) ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
		t = Math.max(0, Math.min(1, t));
		return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
	}

	private static boolean outerRingWithin(double[][] outerRing, double radius) {
		for (double[] point : outerRing) {
			if (Math.hypot(point[0], point[1]) > radius + TOLERANCE_METERS) {
				return false;
			}
		}
		return true;
	}

}
