// SPDX-License-Identifier: LGPL-3.0-or-later
#include "Json.h"

#include <cmath>
#include <cstdio>

namespace bigfish
{
namespace
{
struct Parser
{
	std::string_view text;
	std::size_t pos = 0;
	int depth = 0;

	void SkipWhitespace()
	{
		while (pos < text.size())
		{
			const char aChar = text[pos];
			if (aChar == ' ' || aChar == '\t' || aChar == '\n' || aChar == '\r')
				++pos;
			else
				break;
		}
	}

	bool Consume(char theChar)
	{
		SkipWhitespace();
		if (pos < text.size() && text[pos] == theChar)
		{
			++pos;
			return true;
		}
		return false;
	}

	bool Literal(std::string_view theLiteral)
	{
		if (text.size() - pos < theLiteral.size())
			return false;
		if (text.substr(pos, theLiteral.size()) != theLiteral)
			return false;
		pos += theLiteral.size();
		return true;
	}

	bool ParseString(std::string& theOut)
	{
		if (!Consume('"'))
			return false;
		theOut.clear();
		while (pos < text.size())
		{
			const char aChar = text[pos++];
			if (aChar == '"')
				return true;
			if (aChar == '\\')
			{
				if (pos >= text.size())
					return false;
				const char aEscape = text[pos++];
				switch (aEscape)
				{
				case '"': theOut.push_back('"'); break;
				case '\\': theOut.push_back('\\'); break;
				case '/': theOut.push_back('/'); break;
				case 'b': theOut.push_back('\b'); break;
				case 'f': theOut.push_back('\f'); break;
				case 'n': theOut.push_back('\n'); break;
				case 'r': theOut.push_back('\r'); break;
				case 't': theOut.push_back('\t'); break;
				case 'u':
					// The controller only sends ASCII; reject anything else rather
					// than guessing at a codec.
					if (text.size() - pos < 4)
						return false;
					pos += 4;
					theOut.push_back('?');
					break;
				default:
					return false;
				}
				continue;
			}
			if (static_cast<unsigned char>(aChar) < 0x20)
				return false;
			theOut.push_back(aChar);
		}
		return false;
	}

	bool ParseNumber(double& theOut)
	{
		const std::size_t aStart = pos;
		if (pos < text.size() && (text[pos] == '-' || text[pos] == '+'))
			++pos;
		bool aDigits = false;
		while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9')
		{
			++pos;
			aDigits = true;
		}
		if (pos < text.size() && text[pos] == '.')
		{
			++pos;
			while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9')
			{
				++pos;
				aDigits = true;
			}
		}
		if (!aDigits)
			return false;
		try
		{
			theOut = std::stod(std::string(text.substr(aStart, pos - aStart)));
		}
		catch (...)
		{
			return false;
		}
		return true;
	}

	std::optional<JsonValue> ParseValue()
	{
		if (++depth > 16)
			return std::nullopt;
		SkipWhitespace();
		if (pos >= text.size())
			return std::nullopt;

		JsonValue aValue;
		const char aChar = text[pos];
		if (aChar == '{')
		{
			++pos;
			aValue.type = JsonValue::Type::Object;
			if (Consume('}'))
			{
				--depth;
				return aValue;
			}
			while (true)
			{
				std::string aKey;
				if (!ParseString(aKey))
					return std::nullopt;
				if (!Consume(':'))
					return std::nullopt;
				auto aChild = ParseValue();
				if (!aChild)
					return std::nullopt;
				aValue.object.emplace_back(std::move(aKey), std::move(*aChild));
				if (Consume(','))
					continue;
				if (Consume('}'))
					break;
				return std::nullopt;
			}
			--depth;
			return aValue;
		}
		if (aChar == '[')
		{
			++pos;
			aValue.type = JsonValue::Type::Array;
			if (Consume(']'))
			{
				--depth;
				return aValue;
			}
			while (true)
			{
				auto aChild = ParseValue();
				if (!aChild)
					return std::nullopt;
				aValue.array.push_back(std::move(*aChild));
				if (Consume(','))
					continue;
				if (Consume(']'))
					break;
				return std::nullopt;
			}
			--depth;
			return aValue;
		}
		if (aChar == '"')
		{
			aValue.type = JsonValue::Type::String;
			if (!ParseString(aValue.text))
				return std::nullopt;
			--depth;
			return aValue;
		}
		if (Literal("true"))
		{
			aValue.type = JsonValue::Type::Bool;
			aValue.boolean = true;
			--depth;
			return aValue;
		}
		if (Literal("false"))
		{
			aValue.type = JsonValue::Type::Bool;
			aValue.boolean = false;
			--depth;
			return aValue;
		}
		if (Literal("null"))
		{
			--depth;
			return aValue;
		}
		aValue.type = JsonValue::Type::Number;
		if (!ParseNumber(aValue.number))
			return std::nullopt;
		--depth;
		return aValue;
	}
};
}

const JsonValue* JsonValue::Get(std::string_view theKey) const
{
	if (type != Type::Object)
		return nullptr;
	for (const auto& [aKey, aValue] : object)
	{
		if (aKey == theKey)
			return &aValue;
	}
	return nullptr;
}

std::string JsonValue::StringOr(std::string_view theKey, const std::string& theDefault) const
{
	const JsonValue* aValue = Get(theKey);
	if (!aValue || aValue->type != Type::String)
		return theDefault;
	return aValue->text;
}

double JsonValue::NumberOr(std::string_view theKey, double theDefault) const
{
	const JsonValue* aValue = Get(theKey);
	if (!aValue || aValue->type != Type::Number)
		return theDefault;
	return aValue->number;
}

std::optional<JsonValue> ParseJson(std::string_view theText)
{
	Parser aParser{theText};
	auto aValue = aParser.ParseValue();
	if (!aValue)
		return std::nullopt;
	aParser.SkipWhitespace();
	if (aParser.pos != theText.size())
		return std::nullopt;
	return aValue;
}

std::string JsonEscape(std::string_view theText)
{
	std::string aOut;
	aOut.reserve(theText.size() + 8);
	for (const char aChar : theText)
	{
		switch (aChar)
		{
		case '"': aOut += "\\\""; break;
		case '\\': aOut += "\\\\"; break;
		case '\n': aOut += "\\n"; break;
		case '\r': aOut += "\\r"; break;
		case '\t': aOut += "\\t"; break;
		default:
			if (static_cast<unsigned char>(aChar) < 0x20)
				aOut += "?";
			else
				aOut.push_back(aChar);
		}
	}
	return aOut;
}

std::string JsonNumber(double theValue)
{
	if (!std::isfinite(theValue))
		return "0";
	if (std::floor(theValue) == theValue && std::fabs(theValue) < 1e9)
	{
		char aBuffer[32];
		std::snprintf(aBuffer, sizeof(aBuffer), "%lld", static_cast<long long>(theValue));
		return aBuffer;
	}
	char aBuffer[40];
	std::snprintf(aBuffer, sizeof(aBuffer), "%.3f", theValue);
	return aBuffer;
}
}
