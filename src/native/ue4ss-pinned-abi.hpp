#pragma once
#include <memory>
#include <vector>
#include <string>
#include <string_view>
#ifndef RC_UE4SS_API
#define RC_UE4SS_API __declspec(dllimport)
#endif
namespace RC { using StringType=std::wstring; using StringViewType=std::wstring_view; namespace GUI { class GUITab; } namespace LuaMadeSimple { class Lua; }
    class CppUserModBase
    {
      protected:
        std::vector<std::shared_ptr<GUI::GUITab>> GUITabs{};

      public:
        StringType ModName{};
        StringType ModVersion{};
        StringType ModDescription{};
        StringType ModAuthors{};
        StringType ModIntendedSDKVersion{};

      public:
        RC_UE4SS_API CppUserModBase();
        RC_UE4SS_API virtual ~CppUserModBase();

      public:
        RC_UE4SS_API virtual auto on_update() -> void
        {
        }

        // The 'Unreal' module has been initialized.
        // Before this fires, you cannot use anything in the 'Unreal' namespace.
        RC_UE4SS_API virtual auto on_unreal_init() -> void
        {
        }

        // The UI module has been initialized.
        // This is where you need to use the 'UE4SS_ENABLE_IMGUI' macro if you want to utilize the imgui context of UE4SS.
        RC_UE4SS_API virtual auto on_ui_init() -> void
        {
        }

        RC_UE4SS_API virtual auto on_program_start() -> void
        {
        }

        /**
         * Executes after a Lua mod is started (DEPRECATED).
         * @deprecated Use the overload with LuaMadeSimple::Lua* hook_lua instead. This overload may be removed in the next release.
         * @param mod_name This is the name of the Lua mod that was started.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_luas DEPRECATED: This container previously held multiple hook Lua instances. Now only one hook instance is used.
         */
        [[deprecated("The hook_luas vector parameter is deprecated. Use the single hook_lua pointer overload instead. This overload may be removed in the next release")]]
        RC_UE4SS_API virtual auto on_lua_start(StringViewType mod_name,
                                               LuaMadeSimple::Lua& lua,
                                               LuaMadeSimple::Lua& main_lua,
                                               LuaMadeSimple::Lua& async_lua,
                                               std::vector<LuaMadeSimple::Lua*>& hook_luas) -> void
        {
        }

        /**
         * Executes after a Lua mod of the same name is started (DEPRECATED).
         * @deprecated Use the overload with LuaMadeSimple::Lua* hook_lua instead. This overload may be removed in the next release.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_luas DEPRECATED: This container previously held multiple hook Lua instances. Now only one hook instance is used.
         */
        [[deprecated("The hook_luas vector parameter is deprecated. Use the single hook_lua pointer overload instead. This overload may be removed in the next release")]]
        RC_UE4SS_API virtual auto on_lua_start(LuaMadeSimple::Lua& lua,
                                               LuaMadeSimple::Lua& main_lua,
                                               LuaMadeSimple::Lua& async_lua,
                                               std::vector<LuaMadeSimple::Lua*>& hook_luas) -> void
        {
        }

        /**
         * Executes before a Lua mod is about to be stopped (DEPRECATED).
         * @deprecated Use the overload with LuaMadeSimple::Lua* hook_lua instead. This overload may be removed in the next release.
         * @param mod_name This is the name of the Lua mod that is about to be stopped.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_luas DEPRECATED: This container previously held multiple hook Lua instances. Now only one hook instance is used.
         */
        [[deprecated("The hook_luas vector parameter is deprecated. Use the single hook_lua pointer overload instead. This overload may be removed in the next release")]]
        RC_UE4SS_API virtual auto on_lua_stop(StringViewType mod_name,
                                              LuaMadeSimple::Lua& lua,
                                              LuaMadeSimple::Lua& main_lua,
                                              LuaMadeSimple::Lua& async_lua,
                                              std::vector<LuaMadeSimple::Lua*>& hook_luas) -> void
        {
        }

        /**
         * Executes before a Lua mod of the same name is about to be stopped (DEPRECATED).
         * @deprecated Use the overload with LuaMadeSimple::Lua* hook_lua instead. This overload may be removed in the next release.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_luas DEPRECATED: This container previously held multiple hook Lua instances. Now only one hook instance is used.
         */
        [[deprecated("The hook_luas vector parameter is deprecated. Use the single hook_lua pointer overload instead. This overload may be removed in the next release")]]
        RC_UE4SS_API virtual auto on_lua_stop(LuaMadeSimple::Lua& lua,
                                              LuaMadeSimple::Lua& main_lua,
                                              LuaMadeSimple::Lua& async_lua,
                                              std::vector<LuaMadeSimple::Lua*>& hook_luas) -> void
        {
        }

        RC_UE4SS_API virtual auto on_dll_load(StringViewType dll_name) -> void
        {
        }

        RC_UE4SS_API virtual auto render_tab() -> void {};

        /**
         * Executes after a Lua mod is started.
         * Executes for every Lua mod that is starting.
         * @param mod_name This is the name of the Lua mod that was started.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_lua This is the Lua instance that is used for game-thread hooks like ExecuteInGameThread.
         */
        RC_UE4SS_API virtual auto on_lua_start(StringViewType mod_name,
                                               LuaMadeSimple::Lua& lua,
                                               LuaMadeSimple::Lua& main_lua,
                                               LuaMadeSimple::Lua& async_lua,
                                               LuaMadeSimple::Lua* hook_lua) -> void
        {
        }

        /**
         * Executes after a Lua mod of the same name is started.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_lua This is the Lua instance that is used for game-thread hooks like ExecuteInGameThread.
         */
        RC_UE4SS_API virtual auto on_lua_start(LuaMadeSimple::Lua& lua,
                                               LuaMadeSimple::Lua& main_lua,
                                               LuaMadeSimple::Lua& async_lua,
                                               LuaMadeSimple::Lua* hook_lua) -> void
        {
        }

        /**
         * Executes before a Lua mod is about to be stopped.
         * Executes for every Lua mod that is stopping.
         * @param mod_name This is the name of the Lua mod that is about to be stopped.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_lua This is the Lua instance that is used for game-thread hooks like ExecuteInGameThread.
         */
        RC_UE4SS_API virtual auto on_lua_stop(StringViewType mod_name,
                                              LuaMadeSimple::Lua& lua,
                                              LuaMadeSimple::Lua& main_lua,
                                              LuaMadeSimple::Lua& async_lua,
                                              LuaMadeSimple::Lua* hook_lua) -> void
        {
        }

        /**
         * Executes before a Lua mod of the same name is about to be stopped.
         * @param lua This is the main Lua instance.
         * @param main_lua This is the main Lua thread instance.
         * @param async_lua This is the Lua instance for asynchronous things like ExecuteAsync and ExecuteWithDelay.
         * @param hook_lua This is the Lua instance that is used for game-thread hooks like ExecuteInGameThread.
         */
        RC_UE4SS_API virtual auto on_lua_stop(LuaMadeSimple::Lua& lua,
                                              LuaMadeSimple::Lua& main_lua,
                                              LuaMadeSimple::Lua& async_lua,
                                              LuaMadeSimple::Lua* hook_lua) -> void
        {
        }

        /**
         * Executes after every C++ mod has been loaded.
         */
        RC_UE4SS_API virtual auto on_cpp_mods_loaded() -> void
        {
        }

    };
}
