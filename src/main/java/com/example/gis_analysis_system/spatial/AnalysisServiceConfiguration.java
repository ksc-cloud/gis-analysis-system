package com.example.gis_analysis_system.spatial;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AnalysisServiceProperties.class)
class AnalysisServiceConfiguration {

}
