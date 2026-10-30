// Minimal, dependency-free JSON for the bridge control plane.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bigfish
{
struct JsonValue
{
	enum class Type
	{
		Null,
		Bool,
		Number,
		String,
		Array,
		Object
	};

	Type type = Type::Null;
	bool boolean = false;
	double number = 0.0;
	std::string text;
	std::vector<JsonValue> array;
	std::vector<std::pair<std::string, JsonValue>> object;

	bool IsObject() const { return type == Type::Object; }
	bool IsArray() const { return type == Type::Array; }
	bool IsString() const { return type == Type::String; }
	bool IsNumber() const { return type == Type::Number; }

	const JsonValue* Get(std::string_view theKey) const;
	std::string StringOr(std::string_view theKey, const std::string& theDefault = "") const;
	double NumberOr(std::string_view theKey, double theDefault = 0.0) const;
};

/** Returns nullopt on malformed input; never throws. */
std::optional<JsonValue> ParseJson(std::string_view theText);

/** Escape a UTF-8 string for embedding in a JSON string literal. */
std::string JsonEscape(std::string_view theText);

/** Bounded number formatting: ints without a decimal point, floats with 3 dp. */
std::string JsonNumber(double theValue);
}
