// Development-only executable: real Win32/BCrypt I/O and the production entry
// point, with inert Lua/UE4SS ABI implementations. Never loads UE4SS or a game.
#define RC_LMS_ABI_API
#define RC_UE4SS_API
#include "UnicodeBridge.cpp"
#include <iostream>

namespace {
int parameterReads=0;
bool returnedNil=false;
std::string returnedString, syntheticRoot;
const std::string syntheticRevision(64,'a');
void check(bool condition,const char* message) {
  if(!condition)throw std::runtime_error(message);
}
std::string utf8(const wchar_t* value) {
  const int length=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value,-1,nullptr,0,nullptr,nullptr);
  if(length<=1)throw std::runtime_error("synthetic root conversion");
  std::string result(static_cast<size_t>(length),'\0');
  if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value,-1,result.data(),length,nullptr,nullptr))
    throw std::runtime_error("synthetic root conversion");
  result.pop_back(); return result;
}
}
namespace RC {
CppUserModBase::CppUserModBase()=default;
CppUserModBase::~CppUserModBase()=default;
}
namespace RC::LuaMadeSimple {
void Lua::register_function(const std::string&,const LuaFunction&) const {throw std::runtime_error("unexpected Lua registration");}
int32_t Lua::get_stack_size() const {++parameterReads;return 2;}
bool Lua::is_string(int32_t) const {++parameterReads;return true;}
bool Lua::is_integer(int32_t) const {++parameterReads;return true;}
std::string_view Lua::get_string(int32_t index) const {++parameterReads;return index==1?syntheticRoot:syntheticRevision;}
int64_t Lua::get_integer(int32_t) const {++parameterReads;return 64;}
void Lua::set_string(std::string_view value) const {returnedString=value;}
void Lua::set_nil() const {returnedNil=true;}
}
int wmain(int argc,wchar_t** argv) {
  try {
    check(argc==2,"synthetic root required");
    const auto digest=yijian::current_process_executable_sha256();
    check(digest.size()==64,"invalid digest");
    check(!yijian::secure_equal(digest,SupportedGameExeSha256),"test image unexpectedly equals game");
    syntheticRoot=utf8(argv[1]);
    // Independently prove the persisted synthetic grant is valid. The producer
    // channel must remain uninitialized even with this usable old grant present.
    yijian::Channel fixture;
    fixture.initialize(syntheticRoot,syntheticRevision);
    check(fixture.grant().key==std::string(64,'b'),"invalid synthetic grant");
    check(fixture.grant().writable,"timeline grant lost write permission");
    yijian::Channel observation;
    const auto observationRoot=syntheticRoot+"-observe";
    observation.initialize(observationRoot,syntheticRevision);
    const auto readonly=observation.grant();
    check(!readonly.writable,"observation grants timeline permission");
    check(observation.read(observationRoot+"/config.txt",131072).value==readonly.key+"\n"+readonly.sourceBytes+"\nobserve\n","observation config projection");
    const auto denied=[&](auto work,const char* reason) {
      bool rejected=false;
      try {work();}catch(const std::runtime_error&){rejected=true;}
      check(rejected,reason);
    };
    for(const auto& file:{observationRoot+"/command.txt",observationRoot+"/expected.sav",readonly.sourceBytes+"/29.sav",readonly.sourceBytes+"/JHSaveConfig.sav"})
      denied([&]{observation.read(file,1024);},"observation read escaped scope");
    for(const auto& file:{"response.json","last-command.txt","receipts/00000000-0000-0000-0000-000000000001.sav"})
      denied([&]{observation.write(observationRoot+"/"+file,"synthetic");},"observation write escaped scope");
    RC::LuaMadeSimple::Lua lua;
    for(int attempt=0;attempt<2;++attempt) {
      returnedNil=false;returnedString.clear();
      check(initialize(lua)==2 && returnedNil && returnedString=="unsupported_game_executable","EXE rejection missing");
      check(parameterReads==0,"EXE checked after Lua parameter access");
      try {channel.grant();throw std::runtime_error("rejected producer bound root");}
      catch(const std::runtime_error& error) {check(std::string_view(error.what())=="uninitialized","rejected producer changed channel");}
    }
    std::cout<<"{\"sha256\":\""<<digest<<"\",\"rejected\":true,\"attempts\":2,\"luaParameterReads\":0,\"producerBound\":false,\"validPersistedGrant\":true}\n";
    return 0;
  }catch(const std::exception& error) {
    std::cout<<"{\"error\":\""<<error.what()<<"\"}\n";
    return 3;
  }
}
