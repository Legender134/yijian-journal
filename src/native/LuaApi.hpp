#pragma once
#include <cstdint>
#include <string>
#include <string_view>
#ifndef RC_LMS_ABI_API
#define RC_LMS_ABI_API __declspec(dllimport)
#endif
// The pinned SDK's exact exported methods. The extension never constructs Lua.
namespace RC::LuaMadeSimple {
class Lua {
public:
  using LuaFunction=int(*)(const Lua&);
  RC_LMS_ABI_API void register_function(const std::string&,const LuaFunction&) const;
  RC_LMS_ABI_API int32_t get_stack_size() const;
  RC_LMS_ABI_API bool is_string(int32_t=1) const;
  RC_LMS_ABI_API bool is_integer(int32_t=1) const;
  RC_LMS_ABI_API std::string_view get_string(int32_t=1) const;
  RC_LMS_ABI_API int64_t get_integer(int32_t=1) const;
  RC_LMS_ABI_API void set_string(std::string_view) const;
  RC_LMS_ABI_API void set_nil() const;
};
}
