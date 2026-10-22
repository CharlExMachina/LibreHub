-- Logitech A50 X: send voice-chat apps to the base station's "A50 X Voice" output.
--
-- Everything else follows the default output ("A50 X Game", set by 51-logitech-a50x.conf), so the
-- headset's Game/Voice balance works the way it does on Windows. Each app is routed only the first
-- time it plays: after that, wherever you move it is respected (WirePlumber remembers the choice,
-- and moving an app back to the default output is remembered as "follow the default").

local VOICE_NODE = "alsa_output.usb-Logitech_A50_X*.pro-output-0"

-- Matched case-insensitively against application.process.binary and application.name.
local CHAT_APPS = {
  "discord", "discordcanary", "discordptb", "vesktop", "webcord", "equibop", "armcord", "legcord",
  "webrtc voiceengine", -- Chromium/Electron voice calls (Discord's call audio uses this name)
  "teamspeak", "ts3client", "mumble", "element", "signal", "telegram", "zoom", "skype", "slack",
}

local log = Log.open_topic ("s-logitech-a50x")

-- Apps this script has already routed once (kept in ~/.local/state/wireplumber/logitech-a50x-chat).
local routed_state = State ("logitech-a50x-chat")
local routed = routed_state:load ()

-- The key WirePlumber's node/state-stream.lua stores per-stream preferences under.
local function state_key (props)
  local class = (props ["media.class"] or ""):gsub ("^Stream/", "")
  if props ["media.role"] == "Notification" then
    return class .. ":media.role:Notification"
  end
  for _, k in ipairs ({ "application.id", "application.name", "media.name", "node.name" }) do
    if props [k] then
      return class .. ":" .. k .. ":" .. props [k]
    end
  end
end

local function has_remembered_target (props)
  local key = state_key (props)
  local value = key and State ("stream-properties"):load () [key]
  if not value then
    return false
  end
  local stored = Json.Raw (value)
  return stored:is_object () and stored:parse ().target ~= nil
end

local function is_chat (props)
  for _, key in ipairs ({ "application.process.binary", "application.name" }) do
    local value = props [key]
    if value then
      value = value:lower ()
      for _, app in ipairs (CHAT_APPS) do
        if value:find (app, 1, true) then
          return true
        end
      end
    end
  end
  return false
end

SimpleEventHook {
  name = "logitech-a50x/route-chat-to-voice",
  interests = {
    EventInterest {
      Constraint { "event.type", "=", "node-added" },
      Constraint { "media.class", "=", "Stream/Output/Audio" },
    },
  },
  execute = function (event)
    local node = event:get_subject ()
    local props = node.properties
    if props ["target.object"] or props ["node.target"] or not is_chat (props) then
      return
    end
    local key = state_key (props)
    if not key or routed [key] or has_remembered_target (props) then
      return
    end
    local source = event:get_source ()
    local voice = source:call ("get-object-manager", "node"):lookup {
      Constraint { "node.name", "matches", VOICE_NODE },
    }
    local metadata = source:call ("get-object-manager", "metadata"):lookup {
      Constraint { "metadata.name", "=", "default" },
    }
    if voice and metadata then
      log:info (node, "routing " .. tostring (props ["application.name"]) .. " to A50 X Voice")
      metadata:set (node ["bound-id"], "target.object", "Spa:Id", voice.properties ["object.serial"])
      routed [key] = "voice"
      routed_state:save_after_timeout (routed)
    end
  end,
}:register ()
