"""Reference mapping from a Java radius analysis result to the building-stats request.

Accepts the body of GET /api/buildings/nearby (RadiusAnalysisResult fields at the top level) or of
GET /api/analyses/{id} (AnalysisDetail with the result under "result"). The Java client of step 8-5
should send the same fields.
"""


def to_request(java: dict) -> dict:
    detail = java if "result" not in java else java["result"]
    source = ({"kind": "SAVED", "analysisId": java["analysisId"], "analyzedAt": java.get("analyzedAt")}
              if "analysisId" in java else {"kind": "LIVE", "analyzedAt": java.get("analyzedAt")})
    return {
        "source": source,
        "center": detail["center"],
        "radiusMeters": detail["radiusMeters"],
        "complete": detail["complete"],
        "incompleteReasons": [{"code": r["code"], "message": r["message"]} for r in detail["incompleteReasons"]],
        "javaSummary": detail["summary"],
        "buildings": [
            {
                "id": b["id"],
                "groundFloorRaw": b["building"].get("groundFloorCount"),
                "relation": b["relation"],
                "distanceMeters": b["distanceMeters"],
                "geometry": {"type": "MultiPolygon", "coordinates": b["polygons"]},
            }
            for b in detail["buildings"]
        ],
    }
