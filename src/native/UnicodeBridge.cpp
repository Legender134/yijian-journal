#include "NativeChannel.hpp"
#include "ue4ss-pinned-abi.hpp"
#include "LuaApi.hpp"
#include <mutex>
namespace {
using RC::LuaMadeSimple::Lua;
std::mutex gate;
yijian::Channel channel;
std::string string_arg(const Lua& lua,int index) {
  if(!lua.is_string(index))throw std::runtime_error("string required");
  return std::string(lua.get_string(index));
}
int initialize(const Lua& lua) {
  std::scoped_lock lock(gate);
  try {
    if(lua.get_stack_size()!=2)throw std::runtime_error("initialize arity");
    channel.initialize(string_arg(lua,1),string_arg(lua,2));
    lua.set_string("unicode-v2");return 1;
  }catch(const std::exception& e){lua.set_nil();lua.set_string(e.what());return 2;}
}
int read(const Lua& lua) {
  std::scoped_lock lock(gate);
  try {
    if(lua.get_stack_size()!=2||!lua.is_integer(2))throw std::runtime_error("read arity");
    const auto limit=lua.get_integer(2);
    if(limit<0||limit>yijian::MaxSave)throw std::runtime_error("read limit");
    auto result=channel.read(string_arg(lua,1),static_cast<size_t>(limit));
    if(result.missing){lua.set_nil();lua.set_string("missing");return 2;}
    lua.set_string(result.value);lua.set_string("ok");return 2;
  }catch(const std::exception&){lua.set_nil();lua.set_string("invalid");return 2;}
}
int write(const Lua& lua) {
  std::scoped_lock lock(gate);
  try {
    if(lua.get_stack_size()!=2)throw std::runtime_error("write arity");
    channel.write(string_arg(lua,1),string_arg(lua,2));
    lua.set_string("ok");return 1;
  }catch(const std::exception& e){lua.set_nil();lua.set_string(e.what());return 2;}
}
class UnicodeBridge final:public RC::CppUserModBase {
public:
  void on_lua_start(RC::StringViewType name,Lua& lua,Lua&,Lua&,Lua*) override {
    if(name!=L"YijianJournalBridge"&&name!=L"YijianSaveProbe")return;
    lua.register_function("YijianNativeInitialize",initialize);
    lua.register_function("YijianNativeRead",read);
    lua.register_function("YijianNativeWrite",write);
  }
};
}
extern "C" __declspec(dllexport) RC::CppUserModBase* start_mod(){return new UnicodeBridge();}
extern "C" __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod){delete mod;}
