package com.example.gis_analysis_system;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import javax.sql.DataSource;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;

import com.zaxxer.hikari.HikariDataSource;

/**
 * Guards the separation of the development DB and the test DB: every Spring test context points at
 * gis_analysis_test (src/test/resources/config/application.properties), even though ./application-local.properties
 * holds the development password, and no connection is opened at startup.
 */
@SpringBootTest
class TestDatabaseIsolationTests {

	@Autowired
	private Environment environment;

	@Autowired
	private DataSource dataSource;

	@Test
	void testsNeverUseTheDevelopmentDatabase() throws IOException {
		String url = this.environment.getProperty("spring.datasource.url");
		String username = this.environment.getProperty("spring.datasource.username");

		assertThat(url).startsWith("jdbc:mariadb://").contains("/gis_analysis_test").doesNotContain("/gis_analysis?");
		assertThat(username).isNotEqualTo("gis_app");
		String developmentPassword = developmentPassword();
		if (developmentPassword != null && !developmentPassword.isEmpty()) {
			// Compared without printing either value.
			assertThat(developmentPassword.equals(this.environment.getProperty("spring.datasource.password")))
				.as("the test context must not use the development password")
				.isFalse();
		}
	}

	@Test
	void dataSourceIsTheTestOneAndNotConnectedAtStartup() {
		HikariDataSource hikari = (HikariDataSource) this.dataSource;

		assertThat(hikari.getJdbcUrl()).isEqualTo(this.environment.getProperty("spring.datasource.url"));
		assertThat(hikari.isRunning()).as("the pool starts on first use, not at startup").isFalse();
	}

	private static String developmentPassword() throws IOException {
		Path local = Path.of("application-local.properties");
		if (!Files.isRegularFile(local)) {
			return null;
		}
		Properties properties = new Properties();
		try (Reader reader = Files.newBufferedReader(local, StandardCharsets.UTF_8)) {
			properties.load(reader);
		}
		return properties.getProperty("spring.datasource.password");
	}

}
