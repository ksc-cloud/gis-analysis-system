package com.example.gis_analysis_system.vworld;

/**
 * One building from the VWorld 2D data API layer LT_C_SPBD (도로명주소 건물).
 * Only fields documented in the official LT_C_SPBD guide are mapped. Missing values are {@code null}.
 *
 * @param buildingManagementNumber bd_mgt_sn (건물관리번호). Not the same identifier as the 3D model TD_ID.
 * @param buildingName buld_nm (건물명칭)
 * @param buildingSubName buld_nm_dc (건물부명칭)
 * @param groundFloorCount gro_flo_co (건물층수(지상)), kept as returned by the API
 * @param sido sido (시도명)
 * @param sigungu sigungu (시군구명)
 * @param eupmyeon gu (읍면명칭). Real responses also contain legal-dong names here (for example 한강로3가)
 * @param roadName rd_nm (도로명)
 * @param buildingNumber buld_no (건물번호)
 */
public record BuildingInfo(String buildingManagementNumber, String buildingName, String buildingSubName,
		String groundFloorCount, String sido, String sigungu, String eupmyeon, String roadName, String buildingNumber) {

}
