package com.example.gis_analysis_system.history;

/**
 * Ground floor aggregates of one saved analysis, computed in SQL.
 *
 * @param floorSum sum of the valid floor counts (the average is derived exactly like the live result)
 */
public record FloorStatsRow(int withData, int withoutData, Integer minFloor, Integer maxFloor, long floorSum,
		int bucket1To2, int bucket3To5, int bucket6To10, int bucket11To20, int bucket21Plus) {

}
