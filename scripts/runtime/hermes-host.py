"""Run one isolated Hermes Agent turn using the platform's invocation-scoped tool transport."""
import importlib.metadata
import json
import os
import sys

# Libraries may print initialization diagnostics. Reserve the original stdout for the protocol.
wire = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
SUPPORTED = "0.18.2"


def send(frame):
    wire.write(json.dumps(frame, ensure_ascii=False) + "\n")


def receive():
    line = sys.stdin.buffer.readline(2_000_001)
    if not line or len(line) > 2_000_000:
        raise ValueError("invalid frame")
    return json.loads(line)


def main():
    from run_agent import AIAgent

    version = importlib.metadata.version("hermes-agent")
    if sys.argv[1:] == ["--probe"]:
        send({"version": version, "supported": version == SUPPORTED})
        return
    config = receive()
    if version != SUPPORTED or config["method"] != "configure":
        raise ValueError("unsupported host")
    params = config["params"]
    tools = {spec["name"]: spec for spec in params["tools"]}
    seen = set()

    class ToolIdentityError(Exception):
        pass

    # Only a tool response authorizes a subsequent inference request in this turn.
    # Retain status alone, never response bodies, prompts, headers or credentials.
    inference = {"allowed": True, "status": None, "tool_results": 0, "invalid_id": False}

    def before_request(request):
        if request.method == "POST" and request.url.path.rstrip("/").endswith("/chat/completions"):
            if inference["invalid_id"]:
                raise ToolIdentityError()
            messages = json.loads(request.content)["messages"]
            tool_results = sum(m.get("role") == "tool" for m in messages)
            # Hermes itself appends denial messages for unknown tools before invoking
            # our dispatcher. They authorize exactly one continuation of a completed response.
            new_tool_result = inference["status"] == 200 and tool_results > inference["tool_results"]
            if not inference["allowed"] and not new_tool_result:
                raise RuntimeError("duplicate inference")
            inference.update(allowed=False, status=None, tool_results=tool_results)

    def after_response(response):
        if response.request.url.path.rstrip("/").endswith("/chat/completions"):
            inference["status"] = response.status_code

    class PlatformAgent(AIAgent):
        def _repair_tool_call(self, name):
            # Permissions bind to the exact tool name. Let Hermes return its unknown-tool reply.
            return None

        def _create_openai_client(self, client_kwargs, *, reason, shared):
            client = super()._create_openai_client(client_kwargs, reason=reason, shared=shared)
            client.max_retries = 0
            hooks = client._client.event_hooks
            if before_request not in hooks["request"]:
                hooks["request"].append(before_request)
                hooks["response"].append(after_response)
            return client

        # Hermes supplies the provider's tool-call IDs. The platform owns dispatch, including
        # workspace authorization and interactive questions. Never enter Hermes' built-in executor.
        def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
            calls = assistant_message.tool_calls
            if not 0 < len(calls) <= 16:
                raise ValueError("invalid tool call count")
            for call in calls:
                name, call_id = call.function.name, call.id
                if not isinstance(call_id, str) or not 0 < len(call_id) <= 256 or call_id in seen:
                    inference["invalid_id"] = True
                    raise ToolIdentityError()
                if name in tools:
                    send({"method": "tool", "id": call_id, "params": {"session": self.session_id,
                          "name": name, "arguments": json.loads(call.function.arguments or "{}")}})
                    reply = receive()
                    if reply.get("id") != call_id or "result" not in reply:
                        raise ValueError("incorrect tool response")
                    value = reply["result"]
                else:
                    value = {"error": "This tool is unavailable for this execution."}
                seen.add(call_id)
                messages.append({"role": "tool", "tool_call_id": call_id, "content": json.dumps(value, ensure_ascii=False)})

            inference["allowed"] = True

    agent = PlatformAgent(model=params["model"], api_key=params.pop("key"), base_url=params["endpoint"],
                          provider="custom", api_mode="chat_completions", enabled_toolsets=["collaboration_platform"],
                          session_id=params["session"], skip_memory=True, skip_context_files=True,
                          load_soul_identity=False, quiet_mode=True, save_trajectories=False,
                          max_iterations=12, tool_delay=0, checkpoints_enabled=False)
    agent._api_max_retries = 1
    agent._fallback_chain = []
    agent.tools = [{"type": "function", "function": {"name": name, "description": spec["description"],
                    "parameters": spec["inputSchema"]}} for name, spec in tools.items()]
    agent.valid_tool_names = set(tools)
    if agent.model != params["model"] or agent.provider != "custom" or agent.base_url.rstrip("/") != params["endpoint"].rstrip("/"):
        raise ValueError("incorrect provider")
    send({"id": config["id"], "result": {"session": agent.session_id, "model": agent.model, "version": version}})
    turn = receive()
    if turn.get("method") != "prompt" or turn["params"]["session"] != agent.session_id:
        raise ValueError("incorrect session")
    try:
        result = agent.run_conversation(turn["params"]["text"])
    except ToolIdentityError:
        inference["invalid_id"] = True
    if inference["invalid_id"]:
        send({"id": turn["id"], "result": {"session": agent.session_id, "ok": False, "invalidToolId": True}})
        return
    ok = bool(result.get("completed") and not any(result.get(k) for k in ("failed", "interrupted", "partial"))
              and result.get("api_calls", 0) > 0 and result.get("model") == params["model"]
              and result.get("provider") == "custom" and result.get("final_response"))
    send({"id": turn["id"], "result": {"session": agent.session_id, "ok": ok,
          "rejected": inference["status"] in (400, 401, 403, 404, 422, 429),
          "text": result["final_response"] if ok else "", "input": result.get("input_tokens"),
          "output": result.get("output_tokens")}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider diagnostics can contain request bodies or credentials.
        sys.exit(2)
