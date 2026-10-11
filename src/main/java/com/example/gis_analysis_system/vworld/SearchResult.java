package com.example.gis_analysis_system.vworld;

import java.util.List;

/**
 * One page of a VWorld Search API 2.0 query.
 *
 * @param found {@code false} when VWorld answered NOT_FOUND
 * @param totalCount record.total, or -1 when not reported
 * @param totalPages page.total, or -1 when not reported
 * @param page the requested page
 * @param items results with valid coordinates, in response order
 * @param skippedItems results dropped because their coordinates were missing or outside South Korea
 */
public record SearchResult(boolean found, int totalCount, int totalPages, int page, List<Item> items,
		int skippedItems) {

	public static SearchResult notFound(int page) {
		return new SearchResult(false, 0, 0, page, List.of(), 0);
	}

	/**
	 * @param id VWorld id (POI id, road address id or parcel PNU)
	 * @param title display name: place name, building name of the address, or the address itself
	 * @param subtitle second line (address or building name), or {@code null}
	 * @param category place category or the address kind, or {@code null}
	 * @param roadAddress road name address, or {@code null}
	 * @param parcelAddress parcel (jibun) address, or {@code null}
	 * @param lon WGS84 longitude
	 * @param lat WGS84 latitude
	 */
	public record Item(String id, String title, String subtitle, String category, String roadAddress,
			String parcelAddress, double lon, double lat) {
	}

}
