#!/usr/bin/env python3.12
"""Validate a FHIR R4 Bundle read from stdin. Outputs JSON to stdout."""

import sys
import json
from pydantic import ValidationError
from fhir.resources.R4B import get_fhir_model_class


def validate_resource(resource_dict):
    rt = resource_dict.get("resourceType")
    if not rt:
        return {"resourceType": None, "valid": False, "errors": [{"field": "resourceType", "message": "Missing resourceType"}]}

    try:
        ModelClass = get_fhir_model_class(rt)
    except KeyError:
        return {"resourceType": rt, "valid": False, "errors": [{"field": "resourceType", "message": f"Unknown FHIR resource type: {rt}"}]}

    try:
        ModelClass.model_validate(resource_dict)
        return {"resourceType": rt, "valid": True, "errors": []}
    except ValidationError as e:
        errors = []
        for err in e.errors():
            errors.append({
                "field": ".".join(str(p) for p in err["loc"]),
                "message": err["msg"],
                "type": err["type"],
            })
        return {"resourceType": rt, "valid": False, "errors": errors}


def main():
    raw = sys.stdin.read()
    try:
        bundle = json.loads(raw)
    except json.JSONDecodeError as e:
        json.dump({"valid": False, "error": f"Invalid JSON: {e}"}, sys.stdout)
        return

    entries = bundle.get("entry", [])
    results = []
    total = len(entries)
    valid_count = 0
    invalid_count = 0
    all_errors = []

    for i, entry in enumerate(entries):
        resource = entry.get("resource", entry)
        result = validate_resource(resource)
        if result["valid"]:
            valid_count += 1
        else:
            invalid_count += 1
            for err in result["errors"]:
                err["resourceIndex"] = i
                err["resourceType"] = result["resourceType"]
                all_errors.append(err)
        results.append(result)

    json.dump({
        "totalResources": total,
        "validCount": valid_count,
        "invalidCount": invalid_count,
        "errors": all_errors,
    }, sys.stdout)


if __name__ == "__main__":
    main()
