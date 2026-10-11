-- =====================================================================
-- GIS 3D 지도 - 7단계 분석 이력 테이블 (MariaDB 13.0)
--
-- 개발 DB와 테스트 DB에 각각 한 번씩, 대상 DB를 명시해서 관리자 계정으로 실행한다. (PowerShell, 파일을 클라이언트가 직접 읽게 한다)
--   $m = "C:\Program Files\MariaDB 13.0\bin\mariadb.exe"
--   & $m -h 127.0.0.1 -u root -p --default-character-set=utf8mb4 --abort-source-on-error gis_analysis -e "source C:/Users/PC/gis-analysis-system/db/mariadb/02_schema.sql"
--   & $m -h 127.0.0.1 -u root -p --default-character-set=utf8mb4 --abort-source-on-error gis_analysis_test -e "source C:/Users/PC/gis-analysis-system/db/mariadb/02_schema.sql"
--   PowerShell 은 '<' 리디렉션을 지원하지 않는다. Get-Content ... | mariadb 파이프는 한글 COMMENT 를 '?' 로 바꾸므로 쓰지 않는다.
--   --abort-source-on-error 가 없으면 source 는 오류 뒤의 문장도 계속 실행한다.
--
-- 안전 장치
--   - 이 파일이 utf8mb4 로 정확히 전달되지 않았으면(한글 COMMENT 가 깨질 상황이면) 중단한다.
--   - 현재 DB가 gis_analysis 또는 gis_analysis_test 가 아니면 중단한다. (다른 DB에 잘못 만들지 않음)
--   - 세 테이블 중 하나라도 이미 있으면 아무것도 만들지 않고 중단한다. (IF NOT EXISTS/DROP 사용 안 함)
--   - 테이블/데이터를 삭제하거나 초기화하는 문장은 없다.
--
-- 저장 원칙
--   - VWorld LT_C_SPBD 가 실제로 제공하는 속성만 저장한다. (건물 용도/준공연도 없음, 도로명주소는 구성 요소로 저장)
--   - 도형은 GeoJSON MultiPolygon 원문(JSON)으로 저장해 내부 구멍과 좌표(소수점 7자리)를 그대로 보존한다.
--     MariaDB 의 JSON 은 LONGTEXT COLLATE utf8mb4_bin 별칭이며 JSON_VALID 검사가 자동으로 붙는다.
--   - 중심점 좌표는 DOUBLE 로 저장해 분석에 사용한 값을 손실 없이 보존한다.
--   - 시각(analyzed_at, saved_at)은 애플리케이션이 UTC 로 넣는다. (DB 서버 시간대에 의존하지 않음)
--   - 층수 통계는 저장하지 않고 gis_analysis_building 에서 SQL 로 계산한다.
-- =====================================================================

DELIMITER //

BEGIN NOT ATOMIC
	-- 문자셋 확인: 이 파일이 utf8mb4 로 정확히 전달됐는지 ('한글' 의 UTF-8 바이트는 ED959C EAB880)
	IF @@character_set_client <> 'utf8mb4' OR @@character_set_connection <> 'utf8mb4'
			OR HEX('한글') <> 'ED959CEAB880' THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[ENCODING] SQL file was not received as utf8mb4. Use --default-character-set=utf8mb4 and source. Nothing created.';
	END IF;
	IF DATABASE() IS NULL OR DATABASE() NOT IN ('gis_analysis', 'gis_analysis_test') THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '대상 DB(gis_analysis 또는 gis_analysis_test)를 지정해서 실행하세요. 아무것도 만들지 않았습니다.';
	END IF;
	IF EXISTS (SELECT 1 FROM information_schema.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building')) THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '분석 이력 테이블이 이미 있습니다. 기존 데이터를 보호하기 위해 중단했습니다.';
	END IF;
END //

DELIMITER ;

-- ---------------------------------------------------------------------
-- 분석 이력 (분석 1건 = 1행)
-- ---------------------------------------------------------------------
CREATE TABLE gis_analysis_history (
	analysis_id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
	snapshot_token             CHAR(36)          NOT NULL COMMENT '서버 임시 보관 결과의 토큰(UUID). 중복 저장 방지',
	title                      VARCHAR(100)      NOT NULL,
	center_lon                 DOUBLE            NOT NULL COMMENT 'WGS84 경도',
	center_lat                 DOUBLE            NOT NULL COMMENT 'WGS84 위도',
	radius_m                   SMALLINT UNSIGNED NOT NULL,
	criterion                  VARCHAR(40)       NOT NULL COMMENT '판정 기준 (POLYGON_INTERSECTS_CIRCLE)',
	intersecting_count         INT UNSIGNED      NOT NULL COMMENT '분석 결과 건물 수 (완전 포함 + 경계 걸침)',
	inside_count               INT UNSIGNED      NOT NULL,
	partial_count              INT UNSIGNED      NOT NULL,
	outside_excluded_count     INT UNSIGNED      NOT NULL COMMENT 'VWorld 가 반환했지만 서버 판정에서 반경 밖',
	geometry_unavailable_count INT UNSIGNED      NOT NULL,
	distinct_building_count    INT UNSIGNED      NOT NULL COMMENT '중복 병합 후 건물 수',
	merged_duplicate_count     INT UNSIGNED      NOT NULL,
	reported_total             INT UNSIGNED      NULL     COMMENT 'VWorld record.total. 알 수 없으면 NULL',
	fetched_features           INT UNSIGNED      NOT NULL,
	fetched_pages              TINYINT UNSIGNED  NOT NULL,
	reported_pages             INT UNSIGNED      NULL,
	is_complete                BOOLEAN           NOT NULL,
	source_provider            VARCHAR(100)      NOT NULL,
	source_layer               VARCHAR(100)      NOT NULL,
	source_crs                 VARCHAR(50)       NOT NULL,
	source_notice              VARCHAR(300)      NOT NULL,
	analyzed_at                DATETIME(3)       NOT NULL COMMENT 'UTC. 분석(VWorld 조회) 시각 = 스냅샷 기준 시각',
	saved_at                   DATETIME(3)       NOT NULL COMMENT 'UTC. 저장 시각',
	PRIMARY KEY (analysis_id),
	UNIQUE KEY uk_history_snapshot_token (snapshot_token),
	KEY ix_history_saved_at (saved_at, analysis_id),
	CONSTRAINT ck_history_token CHECK (snapshot_token REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT ck_history_title CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 100),
	CONSTRAINT ck_history_center CHECK (center_lon BETWEEN 124 AND 132 AND center_lat BETWEEN 33 AND 39),
	CONSTRAINT ck_history_radius CHECK (radius_m BETWEEN 50 AND 1000),
	CONSTRAINT ck_history_counts CHECK (
		inside_count + partial_count = intersecting_count
		AND intersecting_count + outside_excluded_count + geometry_unavailable_count = distinct_building_count
		AND distinct_building_count + merged_duplicate_count = fetched_features
		AND intersecting_count <= 5000),
	CONSTRAINT ck_history_pages CHECK (fetched_pages >= 1),
	-- 완전한 결과는 VWorld 전체 건수를 알고 있을 때만 가능하다.
	CONSTRAINT ck_history_complete CHECK (is_complete = 0 OR reported_total IS NOT NULL),
	CONSTRAINT ck_history_times CHECK (saved_at >= analyzed_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'GIS 반경 분석 이력';

-- ---------------------------------------------------------------------
-- 부분 결과 사유 (분석 1건 : 사유 0..N건)
-- ---------------------------------------------------------------------
CREATE TABLE gis_analysis_incomplete_reason (
	analysis_id BIGINT UNSIGNED  NOT NULL,
	seq         TINYINT UNSIGNED NOT NULL,
	reason_code VARCHAR(40)      NOT NULL,
	message     VARCHAR(300)     NOT NULL,
	PRIMARY KEY (analysis_id, seq),
	UNIQUE KEY uk_reason_code (analysis_id, reason_code),
	CONSTRAINT fk_reason_history FOREIGN KEY (analysis_id)
		REFERENCES gis_analysis_history (analysis_id) ON DELETE CASCADE,
	CONSTRAINT ck_reason_seq CHECK (seq >= 1),
	CONSTRAINT ck_reason_code CHECK (reason_code IN ('PAGE_LIMIT', 'TIME_LIMIT', 'EXTERNAL_API_ERROR',
		'EXTERNAL_API_TIMEOUT', 'PAGINATION_INCONSISTENT', 'TOTAL_CHANGED', 'COUNT_MISMATCH', 'TOTAL_UNKNOWN',
		'GEOMETRY_UNAVAILABLE'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '분석 결과가 불완전한 사유';

-- ---------------------------------------------------------------------
-- 건물별 분석 결과 (분석 1건 : 건물 0..5000건, INSIDE/PARTIAL 만 저장)
-- ---------------------------------------------------------------------
CREATE TABLE gis_analysis_building (
	analysis_id        BIGINT UNSIGNED   NOT NULL,
	seq                SMALLINT UNSIGNED NOT NULL COMMENT '목록 순서 (가까운 순, 1부터)',
	building_key       VARCHAR(80)       NOT NULL COMMENT 'bd:<건물관리번호> / feature:<객체 ID> / row:<순번>. 3D 모델 ID 아님',
	bd_mgt_sn          VARCHAR(30)       NULL     COMMENT 'LT_C_SPBD bd_mgt_sn. 없으면 NULL',
	building_name      VARCHAR(200)      NULL     COMMENT 'buld_nm',
	building_sub_name  VARCHAR(200)      NULL     COMMENT 'buld_nm_dc',
	sido               VARCHAR(40)       NULL,
	sigungu            VARCHAR(40)       NULL,
	eupmyeon           VARCHAR(40)       NULL     COMMENT 'gu 필드 원문 (읍/면 외에 법정동명도 들어옴)',
	road_name          VARCHAR(80)       NULL     COMMENT 'rd_nm',
	building_number    VARCHAR(20)       NULL     COMMENT 'buld_no',
	ground_floor_raw   VARCHAR(10)       NULL     COMMENT 'gro_flo_co 원문 ("0" 포함)',
	ground_floor_count SMALLINT UNSIGNED NULL     COMMENT '1 이상의 정수일 때만. 0/비정상 값은 NULL(정보 없음)',
	relation           ENUM('INSIDE', 'PARTIAL') NOT NULL,
	distance_m         DECIMAL(8, 2)     NOT NULL COMMENT '중심점에서 건물 다각형까지 최단 수평거리(m)',
	center_inside      BOOLEAN           NOT NULL,
	has_holes          BOOLEAN           NOT NULL,
	geometry           JSON              NOT NULL COMMENT 'GeoJSON MultiPolygon (경도, 위도), 바깥 테두리 + 내부 구멍',
	PRIMARY KEY (analysis_id, seq),
	UNIQUE KEY uk_building_key (analysis_id, building_key),
	KEY ix_building_bd_mgt_sn (bd_mgt_sn),
	CONSTRAINT fk_building_history FOREIGN KEY (analysis_id)
		REFERENCES gis_analysis_history (analysis_id) ON DELETE CASCADE,
	CONSTRAINT ck_building_seq CHECK (seq BETWEEN 1 AND 5000),
	CONSTRAINT ck_building_key CHECK (building_key REGEXP '^(bd|feature|row):.+'),
	-- bd: 식별자는 건물관리번호가 있을 때만, 그리고 그 값과 일치해야 한다.
	CONSTRAINT ck_building_sn CHECK ((bd_mgt_sn IS NULL AND building_key NOT LIKE 'bd:%')
		OR (bd_mgt_sn IS NOT NULL AND building_key = CONCAT('bd:', bd_mgt_sn))),
	CONSTRAINT ck_building_floor CHECK (ground_floor_count IS NULL OR ground_floor_count >= 1),
	CONSTRAINT ck_building_distance CHECK (distance_m BETWEEN 0 AND 1000 AND (center_inside = 0 OR distance_m = 0)),
	CONSTRAINT ck_building_geometry CHECK (JSON_VALUE(geometry, '$.type') = 'MultiPolygon'
		AND JSON_LENGTH(geometry, '$.coordinates') >= 1
		AND CHAR_LENGTH(geometry) <= 500000)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '분석별 건물 결과';

-- 결과 확인
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
	FROM information_schema.TABLES
	WHERE TABLE_SCHEMA = DATABASE()
	AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building');
