#pragma once
#include "UnicodeIo.hpp"
namespace yijian {
struct Grant { std::string key,sourceBytes,binding; std::wstring source; };
class Channel {
  std::string rootBytes,revision;
  std::wstring root;
  static std::vector<std::string> lines(const std::string& input) {
    std::vector<std::string> out; size_t start=0;
    for(size_t end;(end=input.find('\n',start))!=input.npos;start=end+1)out.push_back(input.substr(start,end-start));
    if(out.empty() || input.back()!='\n')throw std::runtime_error("invalid config"); return out;
  }
  static bool root_read(std::wstring_view name) {
    return name==L"config.txt"||name==L"command.txt"||name==L"expected.sav"||name==L"last-command.txt";
  }
  static bool root_write(std::wstring_view name) {
    return name==L"state.json"||name==L"response.json"||name==L"last-command.txt"||name==L"started.txt"||name==L"schedule-error.txt"||
      std::regex_match(std::wstring(name),std::wregex(L"receipts\\\\[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.sav"));
  }
public:
  void initialize(std::string nextRootBytes,std::string nextRevision) {
    const auto nextRoot=checked_path(utf16(nextRootBytes));
    if(!std::regex_match(nextRevision,std::regex("[a-f0-9]{64}")))throw std::runtime_error("revision");
    no_reparse(nextRoot);
    if(!root.empty() && (!equal_path(root,nextRoot)||revision!=nextRevision))throw std::runtime_error("binding already fixed");
    root=nextRoot;rootBytes=std::move(nextRootBytes);revision=std::move(nextRevision);
  }
  Grant grant() const {
    if(root.empty())throw std::runtime_error("uninitialized");
    const auto token=read_file(root+L"\\token.txt",64);
    const auto config=read_file(root+L"\\config.txt",131072);
    if(token.missing||config.missing)throw std::runtime_error("explicit source grant required");
    const auto p=lines(config.value);
    if(p.size()!=9 || p[0]!="2" || p[1]!=token.value ||
       !std::regex_match(p[3],std::regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) ||
       !std::regex_match(p[4],std::regex("[0-9]{17}")) || p[5]!="21798996" || p[6]!="29" || p[7]!=revision ||
       !std::regex_match(p[8],std::regex("[a-f0-9]{64}")))throw std::runtime_error("invalid grant identity");
    const auto split=config.value.rfind(p[8]+"\n");
    const auto binding=config.value.substr(0,split)+rootBytes+"\n";
    if(!secure_equal(hmac(token.value,binding),p[8]))throw std::runtime_error("grant MAC");
    const auto source=checked_path(utf16(p[2]));
    const auto tail=L"\\"+std::wstring(p[4].begin(),p[4].end())+L"\\SaveGames";
    if(source.size()<=tail.size()||!equal_path(source.substr(source.size()-tail.size()),tail))throw std::runtime_error("source account");
    no_reparse(source);
    const auto within=[](const auto& child,const auto& parent) {
      return child.size()>parent.size() && child[parent.size()]==L'\\' && equal_path(child.substr(0,parent.size()),parent);
    };
    if(equal_path(root,source) || within(source,root) || within(root,source))throw std::runtime_error("source overlaps root");
    return {token.value,p[2],binding,source};
  }
  Bytes read(std::string_view input,size_t limit) const {
    const auto file=checked_path(utf16(input));
    Grant g=grant();
    const bool own=file.starts_with(root+L"\\");
    const auto name=own?file.substr(root.size()+1):L"";
    if(!(own&&root_read(name)) && !equal_path(file,g.source+L"\\29.sav") &&
       !equal_path(file,g.source+L"\\JHSaveConfig.sav"))throw std::runtime_error("read scope");
    auto result=read_file(file,limit);
    if(result.missing)return result;
    if(name==L"config.txt")result.value=g.key+"\n"+g.sourceBytes+"\n";
    if(name==L"command.txt") {
      const auto split=result.value.rfind('\t');
      if(split==result.value.npos || result.value.back()!='\n')throw std::runtime_error("command frame");
      const auto base=result.value.substr(0,split)+"\n",mac=result.value.substr(split+1,result.value.size()-split-2);
      if(!secure_equal(hmac(g.key,base+g.binding),mac))throw std::runtime_error("command MAC");
      result.value=base;
    }
    return result;
  }
  void write(std::string_view input,std::string_view bytes) const {
    if(root.empty())throw std::runtime_error("uninitialized");
    const auto file=checked_path(utf16(input));
    if(!file.starts_with(root+L"\\")||!root_write(file.substr(root.size()+1)))throw std::runtime_error("write scope");
    write_file(file,bytes);
  }
};
}
