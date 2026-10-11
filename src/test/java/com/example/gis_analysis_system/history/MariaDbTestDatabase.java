package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;

/**
 * Guard for the MariaDB integration tests. They run only when GIS_TEST_DB_URL, GIS_TEST_DB_USERNAME and
 * GIS_TEST_DB_PASSWORD are set (mapped to spring.datasource.* by src/test/resources/config/application.properties),
 * and refuse to start unless the URL points at the database gis_analysis_test with an account other than gis_app.
 */
final class MariaDbTestDatabase {

	static final String ENABLED_VARIABLE = "GIS_TEST_DB_URL";

	private MariaDbTestDatabase() {
	}

	static void requireTestDatabase() {
		String url = System.getenv("GIS_TEST_DB_URL");
		String username = System.getenv("GIS_TEST_DB_USERNAME");
		assertThat(url).as("GIS_TEST_DB_URL").startsWith("jdbc:mariadb://");
		String path = URI.create(url.substring("jdbc:".length())).getPath();
		assertThat(path).as("database in GIS_TEST_DB_URL (only gis_analysis_test may be used by tests)")
			.isEqualTo("/gis_analysis_test");
		assertThat(username).as("GIS_TEST_DB_USERNAME").isNotBlank().isNotEqualTo("gis_app");
	}

}
