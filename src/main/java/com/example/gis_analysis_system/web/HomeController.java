package com.example.gis_analysis_system.web;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HomeController {

	private final String applicationName;

	private final String vworldApiKey;

	public HomeController(@Value("${spring.application.name}") String applicationName,
			@Value("${vworld.api-key:}") String vworldApiKey) {
		this.applicationName = applicationName;
		this.vworldApiKey = (vworldApiKey != null) ? vworldApiKey.trim() : "";
	}

	@GetMapping("/")
	public String home(Model model) {
		model.addAttribute("applicationName", applicationName);
		model.addAttribute("pageTitle", "GIS 3D 지도");

		boolean vworldEnabled = StringUtils.hasText(vworldApiKey);
		model.addAttribute("vworldEnabled", vworldEnabled);
		if (vworldEnabled) {
			// The key is placed in a script URL, so it is URL-encoded here and HTML-escaped in the JSP.
			model.addAttribute("vworldApiKey", URLEncoder.encode(vworldApiKey, StandardCharsets.UTF_8));
		}
		return "index";
	}

}
