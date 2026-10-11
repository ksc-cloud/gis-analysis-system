-- =====================================================================
-- GIS 3D 지도 - 7단계 분석 이력 테이블 COMMENT 복구 (MariaDB 13.0)
--
-- 02_schema.sql 실행 시 클라이언트 문자 변환 문제로 한글 COMMENT가 '?' 로 저장된 것을
-- COMMENT만 원래 값으로 되돌린다. 02_schema.sql 은 다시 실행하지 않는다.
--
-- 바꾸는 것 : 테이블 COMMENT 3개, 한글이 들어간 컬럼 COMMENT 18개 (영문만 있는 COMMENT는 손상되지 않아 그대로 둔다)
-- 바꾸지 않는 것 : 테이블 삭제/재생성, 데이터, 컬럼 타입/NULL 여부/문자셋, 제약 조건, 인덱스, 컬럼 순서
--
-- 안전 장치 (아래 블록은 하나의 문장이다. 검사에 걸리면 ALTER 는 하나도 실행되지 않는다)
--   1. 이 파일이 utf8mb4 로 정확히 전달됐는지 확인한다. (한글이 깨진 채 들어오면 중단: 같은 손상 반복 방지)
--   2. 대상 DB가 gis_analysis 또는 gis_analysis_test 인지 확인한다.
--   3. 대상 컬럼의 현재 정의(타입, NULL 여부, 기본값, 문자셋/정렬, EXTRA)가 02_schema.sql 과 같은지 확인한다.
--      다르면 MODIFY 가 정의를 바꿀 수 있으므로 중단한다.
--   4. 현재 COMMENT 가 '손상된 값' 또는 '이미 복구된 값' 일 때만 진행한다.
--      그 밖의 값(누군가 의도적으로 바꾼 COMMENT)은 덮어쓰지 않고 중단한다. 다시 실행해도 안전하다.
--   5. ALTER TABLE 은 ALGORITHM = INSTANT 로 실행한다. 메타데이터만 바꾸는 변경이 아니면
--      MariaDB 가 테이블을 재구성하지 않고 오류로 거부한다.
--   6. 변경 후 COMMENT, 컬럼 정의, 제약 조건 수, 인덱스 수, 행 수를 다시 확인한다.
--   DROP / TRUNCATE / DELETE / UPDATE / CREATE TABLE(영구 테이블) 문장은 없다.
--   확인용 임시 테이블(TEMPORARY) 하나만 세션 안에서 쓰며, 접속을 끊으면 사라진다.
--
-- 실행 방법 (PowerShell, 관리자 계정, DB마다 한 번씩. 파일을 클라이언트가 직접 읽게 한다)
--   $m = "C:\Program Files\MariaDB 13.0\bin\mariadb.exe"
--   & $m -h 127.0.0.1 -u root -p --default-character-set=utf8mb4 --abort-source-on-error gis_analysis -e "source C:/Users/PC/gis-analysis-system/db/mariadb/03_fix_comments.sql"
--   & $m -h 127.0.0.1 -u root -p --default-character-set=utf8mb4 --abort-source-on-error gis_analysis_test -e "source C:/Users/PC/gis-analysis-system/db/mariadb/03_fix_comments.sql"
--   Get-Content ... | mariadb 처럼 PowerShell 파이프로 넘기지 않는다. (Windows PowerShell 5.1 은 한글을 '?' 로 바꾼다)
-- =====================================================================

DELIMITER //

BEGIN NOT ATOMIC
	DECLARE v_rows_before BIGINT;
	DECLARE v_checks_before INT;
	DECLARE v_indexes_before INT;

	-- 1. 문자셋 확인: 한글 '한글' 의 UTF-8 바이트는 ED959C EAB880 이어야 한다.
	IF @@character_set_client <> 'utf8mb4' OR @@character_set_connection <> 'utf8mb4'
			OR HEX('한글') <> 'ED959CEAB880' THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[ENCODING] SQL file was not received as utf8mb4. Use --default-character-set=utf8mb4 and source. Nothing changed.';
	END IF;

	-- 2. 대상 DB 확인
	IF DATABASE() IS NULL OR DATABASE() NOT IN ('gis_analysis', 'gis_analysis_test') THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[DATABASE] 대상 DB(gis_analysis 또는 gis_analysis_test)를 지정해서 실행하세요. 아무것도 바꾸지 않았습니다.';
	END IF;
	IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building')) <> 3 THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[TABLES] 분석 이력 테이블 3개가 모두 있어야 합니다. 아무것도 바꾸지 않았습니다.';
	END IF;

	-- 3. 기대값 (02_schema.sql 의 정의와 COMMENT 원문). column_name = '' 은 테이블 COMMENT.
	CREATE OR REPLACE TEMPORARY TABLE tmp_gis_comment_fix (
		table_name   VARCHAR(64)  NOT NULL,
		column_name  VARCHAR(64)  NOT NULL,
		column_type  VARCHAR(64)  NULL,
		is_nullable  VARCHAR(3)   NULL,
		collation    VARCHAR(64)  NULL,
		comment_text VARCHAR(300) NOT NULL,
		PRIMARY KEY (table_name, column_name)
	) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

	INSERT INTO tmp_gis_comment_fix VALUES
		('gis_analysis_history', '', NULL, NULL, NULL, 'GIS 반경 분석 이력'),
		('gis_analysis_history', 'snapshot_token', 'char(36)', 'NO', 'utf8mb4_unicode_ci', '서버 임시 보관 결과의 토큰(UUID). 중복 저장 방지'),
		('gis_analysis_history', 'center_lon', 'double', 'NO', NULL, 'WGS84 경도'),
		('gis_analysis_history', 'center_lat', 'double', 'NO', NULL, 'WGS84 위도'),
		('gis_analysis_history', 'criterion', 'varchar(40)', 'NO', 'utf8mb4_unicode_ci', '판정 기준 (POLYGON_INTERSECTS_CIRCLE)'),
		('gis_analysis_history', 'intersecting_count', 'int(10) unsigned', 'NO', NULL, '분석 결과 건물 수 (완전 포함 + 경계 걸침)'),
		('gis_analysis_history', 'outside_excluded_count', 'int(10) unsigned', 'NO', NULL, 'VWorld 가 반환했지만 서버 판정에서 반경 밖'),
		('gis_analysis_history', 'distinct_building_count', 'int(10) unsigned', 'NO', NULL, '중복 병합 후 건물 수'),
		('gis_analysis_history', 'reported_total', 'int(10) unsigned', 'YES', NULL, 'VWorld record.total. 알 수 없으면 NULL'),
		('gis_analysis_history', 'analyzed_at', 'datetime(3)', 'NO', NULL, 'UTC. 분석(VWorld 조회) 시각 = 스냅샷 기준 시각'),
		('gis_analysis_history', 'saved_at', 'datetime(3)', 'NO', NULL, 'UTC. 저장 시각'),
		('gis_analysis_incomplete_reason', '', NULL, NULL, NULL, '분석 결과가 불완전한 사유'),
		('gis_analysis_building', '', NULL, NULL, NULL, '분석별 건물 결과'),
		('gis_analysis_building', 'seq', 'smallint(5) unsigned', 'NO', NULL, '목록 순서 (가까운 순, 1부터)'),
		('gis_analysis_building', 'building_key', 'varchar(80)', 'NO', 'utf8mb4_unicode_ci', 'bd:<건물관리번호> / feature:<객체 ID> / row:<순번>. 3D 모델 ID 아님'),
		('gis_analysis_building', 'bd_mgt_sn', 'varchar(30)', 'YES', 'utf8mb4_unicode_ci', 'LT_C_SPBD bd_mgt_sn. 없으면 NULL'),
		('gis_analysis_building', 'eupmyeon', 'varchar(40)', 'YES', 'utf8mb4_unicode_ci', 'gu 필드 원문 (읍/면 외에 법정동명도 들어옴)'),
		('gis_analysis_building', 'ground_floor_raw', 'varchar(10)', 'YES', 'utf8mb4_unicode_ci', 'gro_flo_co 원문 ("0" 포함)'),
		('gis_analysis_building', 'ground_floor_count', 'smallint(5) unsigned', 'YES', NULL, '1 이상의 정수일 때만. 0/비정상 값은 NULL(정보 없음)'),
		('gis_analysis_building', 'distance_m', 'decimal(8,2)', 'NO', NULL, '중심점에서 건물 다각형까지 최단 수평거리(m)'),
		('gis_analysis_building', 'geometry', 'longtext', 'NO', 'utf8mb4_bin', 'GeoJSON MultiPolygon (경도, 위도), 바깥 테두리 + 내부 구멍');

	-- 4. 컬럼 정의가 02_schema.sql 과 같은지 확인 (다르면 MODIFY 가 정의를 바꿀 수 있으므로 중단)
	IF (SELECT COUNT(*) FROM tmp_gis_comment_fix e
			JOIN information_schema.COLUMNS c
				ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.table_name AND c.COLUMN_NAME = e.column_name
			WHERE e.column_name <> ''
			AND c.COLUMN_TYPE = e.column_type
			AND c.IS_NULLABLE = e.is_nullable
			AND c.COLLATION_NAME <=> e.collation
			AND c.EXTRA = ''
			AND ((e.is_nullable = 'NO' AND c.COLUMN_DEFAULT IS NULL)
				OR (e.is_nullable = 'YES' AND c.COLUMN_DEFAULT = 'NULL'))) <> 18 THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[DEFINITION] 컬럼 정의가 02_schema.sql 과 다릅니다. 정의 변경을 막기 위해 중단했습니다. 아무것도 바꾸지 않았습니다.';
	END IF;
	-- geometry 컬럼의 JSON 검사 (CHECK json_valid) 가 있어야 한다. (MODIFY ... JSON 이 같은 검사를 다시 붙인다)
	IF NOT EXISTS (SELECT 1 FROM information_schema.CHECK_CONSTRAINTS
			WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'gis_analysis_building'
			AND LEVEL = 'Column' AND CHECK_CLAUSE = 'json_valid(`geometry`)') THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[DEFINITION] geometry 컬럼의 JSON 검사가 예상과 다릅니다. 아무것도 바꾸지 않았습니다.';
	END IF;

	-- 5. 현재 COMMENT 가 손상된 값(한글 -> '?') 또는 이미 복구된 값일 때만 진행
	IF EXISTS (SELECT 1 FROM tmp_gis_comment_fix e
			LEFT JOIN information_schema.COLUMNS c
				ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.table_name AND c.COLUMN_NAME = e.column_name
			LEFT JOIN information_schema.TABLES t
				ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = e.table_name
			WHERE CONVERT(IF(e.column_name = '', t.TABLE_COMMENT, c.COLUMN_COMMENT) USING utf8mb4) COLLATE utf8mb4_bin
				NOT IN (e.comment_text, REGEXP_REPLACE(e.comment_text, '[^[:ascii:]]', '?'))
			OR IF(e.column_name = '', t.TABLE_COMMENT, c.COLUMN_COMMENT) IS NULL) THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[COMMENT] 손상 형태가 아닌 COMMENT 가 있습니다. 의도적으로 바뀐 값을 덮어쓰지 않도록 중단했습니다. 아무것도 바꾸지 않았습니다.';
	END IF;

	-- 변경 전 상태 기록 (변경 후 비교)
	SELECT (SELECT COUNT(*) FROM gis_analysis_history) + (SELECT COUNT(*) FROM gis_analysis_incomplete_reason)
			+ (SELECT COUNT(*) FROM gis_analysis_building)
		INTO v_rows_before;
	SELECT COUNT(*) INTO v_checks_before FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
		AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building');
	SELECT COUNT(*) INTO v_indexes_before FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
		AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building');

	-- 6. COMMENT 복구. 정의는 02_schema.sql 과 같게 다시 적고(타입/NULL/문자셋), 위치 지정(FIRST/AFTER)은 하지 않는다.
	--    ALGORITHM = INSTANT: 메타데이터만 바뀌지 않는 변경이면 MariaDB 가 재구성 대신 오류를 낸다.
	ALTER TABLE gis_analysis_history
		MODIFY snapshot_token          CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '서버 임시 보관 결과의 토큰(UUID). 중복 저장 방지',
		MODIFY center_lon              DOUBLE            NOT NULL COMMENT 'WGS84 경도',
		MODIFY center_lat              DOUBLE            NOT NULL COMMENT 'WGS84 위도',
		MODIFY criterion               VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '판정 기준 (POLYGON_INTERSECTS_CIRCLE)',
		MODIFY intersecting_count      INT UNSIGNED      NOT NULL COMMENT '분석 결과 건물 수 (완전 포함 + 경계 걸침)',
		MODIFY outside_excluded_count  INT UNSIGNED      NOT NULL COMMENT 'VWorld 가 반환했지만 서버 판정에서 반경 밖',
		MODIFY distinct_building_count INT UNSIGNED      NOT NULL COMMENT '중복 병합 후 건물 수',
		MODIFY reported_total          INT UNSIGNED      NULL     COMMENT 'VWorld record.total. 알 수 없으면 NULL',
		MODIFY analyzed_at             DATETIME(3)       NOT NULL COMMENT 'UTC. 분석(VWorld 조회) 시각 = 스냅샷 기준 시각',
		MODIFY saved_at                DATETIME(3)       NOT NULL COMMENT 'UTC. 저장 시각',
		COMMENT = 'GIS 반경 분석 이력',
		ALGORITHM = INSTANT;

	ALTER TABLE gis_analysis_incomplete_reason
		COMMENT = '분석 결과가 불완전한 사유',
		ALGORITHM = INSTANT;

	ALTER TABLE gis_analysis_building
		MODIFY seq                SMALLINT UNSIGNED NOT NULL COMMENT '목록 순서 (가까운 순, 1부터)',
		MODIFY building_key       VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'bd:<건물관리번호> / feature:<객체 ID> / row:<순번>. 3D 모델 ID 아님',
		MODIFY bd_mgt_sn          VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT 'LT_C_SPBD bd_mgt_sn. 없으면 NULL',
		MODIFY eupmyeon           VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT 'gu 필드 원문 (읍/면 외에 법정동명도 들어옴)',
		MODIFY ground_floor_raw   VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT 'gro_flo_co 원문 ("0" 포함)',
		MODIFY ground_floor_count SMALLINT UNSIGNED NULL     COMMENT '1 이상의 정수일 때만. 0/비정상 값은 NULL(정보 없음)',
		MODIFY distance_m         DECIMAL(8, 2)     NOT NULL COMMENT '중심점에서 건물 다각형까지 최단 수평거리(m)',
		MODIFY geometry           JSON              NOT NULL COMMENT 'GeoJSON MultiPolygon (경도, 위도), 바깥 테두리 + 내부 구멍',
		COMMENT = '분석별 건물 결과',
		ALGORITHM = INSTANT;

	-- 7. 변경 후 확인 (ALTER 는 이미 반영됐으므로, 여기서 걸리면 결과를 알려 달라는 뜻이다)
	IF (SELECT COUNT(*) FROM tmp_gis_comment_fix e
			JOIN information_schema.COLUMNS c
				ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.table_name AND c.COLUMN_NAME = e.column_name
			WHERE e.column_name <> ''
			AND c.COLUMN_TYPE = e.column_type AND c.IS_NULLABLE = e.is_nullable
			AND c.COLLATION_NAME <=> e.collation AND c.EXTRA = ''
			AND CONVERT(c.COLUMN_COMMENT USING utf8mb4) COLLATE utf8mb4_bin = e.comment_text) <> 18
		OR (SELECT COUNT(*) FROM tmp_gis_comment_fix e
			JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = e.table_name
			WHERE e.column_name = ''
			AND CONVERT(t.TABLE_COMMENT USING utf8mb4) COLLATE utf8mb4_bin = e.comment_text) <> 3
		OR (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
			AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building')) <> v_checks_before
		OR (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME IN ('gis_analysis_history', 'gis_analysis_incomplete_reason', 'gis_analysis_building')) <> v_indexes_before
		OR (SELECT COUNT(*) FROM gis_analysis_history) + (SELECT COUNT(*) FROM gis_analysis_incomplete_reason)
			+ (SELECT COUNT(*) FROM gis_analysis_building) <> v_rows_before THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[VERIFY] COMMENT 는 변경됐지만 사후 확인이 예상과 다릅니다. 결과를 알려 주세요.';
	END IF;
END //

DELIMITER ;

-- 결과 확인: 바이트(HEX)까지 기대값과 같으면 ok = 1
SELECT e.table_name, IF(e.column_name = '', '(table)', e.column_name) AS target,
		CONVERT(IF(e.column_name = '', t.TABLE_COMMENT, c.COLUMN_COMMENT) USING utf8mb4) COLLATE utf8mb4_bin = e.comment_text AS ok
	FROM tmp_gis_comment_fix e
	LEFT JOIN information_schema.COLUMNS c
		ON c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = e.table_name AND c.COLUMN_NAME = e.column_name
	LEFT JOIN information_schema.TABLES t
		ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = e.table_name
	ORDER BY e.table_name, e.column_name;
