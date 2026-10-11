-- =====================================================================
-- GIS 3D 지도 - 7단계 DB 환경 구축 (MariaDB 13.0)
--
-- 만드는 것
--   gis_analysis       : 개발(운영) DB
--   gis_analysis_test  : 테스트 전용 DB (자동 테스트는 이 DB만 사용)
--   gis_app@127.0.0.1  : 애플리케이션 계정 - gis_analysis 에 SELECT, INSERT, DELETE 만
--   gis_test@127.0.0.1 : 테스트 계정       - gis_analysis_test 에 SELECT, INSERT, DELETE 만
--   테이블은 02_schema.sql 로 관리자 계정이 만든다. (앱/테스트 계정에는 DDL 권한 없음)
--
-- 안전 장치
--   - 실제 비밀번호는 이 파일에 없다. 실행하는 세션에서 변수로만 전달한다.
--   - 같은 이름의 DB나 계정이 하나라도 있으면 아무것도 만들지 않고 중단한다.
--   - DB/계정/데이터를 삭제하거나 초기화하는 문장은 없다.
--   - 계정 호스트는 127.0.0.1 로 제한한다. (JDBC URL 도 127.0.0.1 을 사용)
--
-- 실행 방법 (관리자 계정, PowerShell 에서 mariadb 클라이언트를 대화형으로 연다)
--   & "C:\Program Files\MariaDB 13.0\bin\mariadb.exe" -h 127.0.0.1 -u root -p --default-character-set=utf8mb4 --abort-source-on-error
--   SET @gis_app_password  = '직접 정한 비밀번호';
--   SET @gis_test_password = '직접 정한 다른 비밀번호';
--   SOURCE C:/Users/PC/gis-analysis-system/db/mariadb/01_setup.sql
--   (실행 후 같은 세션에서 변수가 지워졌는지 확인: SELECT @gis_app_password IS NULL;)
--   Get-Content ... | mariadb 처럼 PowerShell 파이프로 넘기지 않는다. (Windows PowerShell 5.1 은 한글을 '?' 로 바꾼다)
-- =====================================================================

DELIMITER //

BEGIN NOT ATOMIC
	DECLARE stmt TEXT;

	-- 0. 문자셋 확인: 이 파일이 utf8mb4 로 정확히 전달됐는지 ('한글' 의 UTF-8 바이트는 ED959C EAB880)
	IF @@character_set_client <> 'utf8mb4' OR @@character_set_connection <> 'utf8mb4'
			OR HEX('한글') <> 'ED959CEAB880' THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '[ENCODING] SQL file was not received as utf8mb4. Use --default-character-set=utf8mb4 and SOURCE. Nothing created.';
	END IF;

	-- 1. 입력값 확인 (무엇이든 만들기 전에)
	IF @gis_app_password IS NULL OR CHAR_LENGTH(@gis_app_password) < 12 THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '@gis_app_password 를 12자 이상으로 먼저 설정하세요. 아무것도 만들지 않았습니다.';
	END IF;
	IF @gis_test_password IS NULL OR CHAR_LENGTH(@gis_test_password) < 12 THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '@gis_test_password 를 12자 이상으로 먼저 설정하세요. 아무것도 만들지 않았습니다.';
	END IF;
	IF @gis_app_password = @gis_test_password THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = '개발 계정과 테스트 계정의 비밀번호를 다르게 설정하세요. 아무것도 만들지 않았습니다.';
	END IF;

	-- 2. 기존 DB/계정과 충돌하는지 확인 (하나라도 있으면 중단)
	IF EXISTS (SELECT 1 FROM information_schema.SCHEMATA
			WHERE SCHEMA_NAME IN ('gis_analysis', 'gis_analysis_test')) THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = 'gis_analysis 또는 gis_analysis_test DB가 이미 있습니다. 기존 DB를 보호하기 위해 중단했습니다.';
	END IF;
	IF EXISTS (SELECT 1 FROM mysql.user WHERE User IN ('gis_app', 'gis_test')) THEN
		SIGNAL SQLSTATE '45000'
			SET MESSAGE_TEXT = 'gis_app 또는 gis_test 계정이 이미 있습니다. 기존 계정을 보호하기 위해 중단했습니다.';
	END IF;

	-- 3. DB 생성 (문자셋을 명시한다)
	CREATE DATABASE gis_analysis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
	CREATE DATABASE gis_analysis_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

	-- 4. 계정 생성 (비밀번호는 세션 변수에서 QUOTE()로 안전하게 전달)
	SET stmt = CONCAT('CREATE USER ''gis_app''@''127.0.0.1'' IDENTIFIED BY ', QUOTE(@gis_app_password));
	EXECUTE IMMEDIATE stmt;
	SET stmt = CONCAT('CREATE USER ''gis_test''@''127.0.0.1'' IDENTIFIED BY ', QUOTE(@gis_test_password));
	EXECUTE IMMEDIATE stmt;
	SET stmt = NULL;

	-- 5. 최소 권한 (분석 이력은 수정 기능이 없으므로 UPDATE 제외, DDL 제외)
	GRANT SELECT, INSERT, DELETE ON gis_analysis.* TO 'gis_app'@'127.0.0.1';
	GRANT SELECT, INSERT, DELETE ON gis_analysis_test.* TO 'gis_test'@'127.0.0.1';
END //

DELIMITER ;

-- 세션에 남은 비밀번호 변수를 지운다.
SET @gis_app_password = NULL;
SET @gis_test_password = NULL;

-- 결과 확인 (비밀번호와 비밀번호 해시는 표시하지 않는다. SHOW GRANTS 는 해시를 출력하므로 사용하지 않는다)
SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
	FROM information_schema.SCHEMATA
	WHERE SCHEMA_NAME IN ('gis_analysis', 'gis_analysis_test');
SELECT GRANTEE, TABLE_SCHEMA, GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE) AS PRIVILEGES
	FROM information_schema.SCHEMA_PRIVILEGES
	WHERE GRANTEE IN ('''gis_app''@''127.0.0.1''', '''gis_test''@''127.0.0.1''')
	GROUP BY GRANTEE, TABLE_SCHEMA;
