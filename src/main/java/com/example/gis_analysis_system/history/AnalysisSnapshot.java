package com.example.gis_analysis_system.history;

import java.time.Instant;
import java.util.UUID;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;

/**
 * A radius analysis result kept on the server so it can be saved later without the browser sending it back.
 *
 * @param token random identifier handed to the client (only allows saving this result)
 * @param result the result exactly as returned to the client
 * @param analyzedAt when the analysis finished (UTC, millisecond precision)
 * @param expiresAt after this the result can no longer be saved
 */
public record AnalysisSnapshot(UUID token, RadiusAnalysisResult result, Instant analyzedAt, Instant expiresAt) {

}
