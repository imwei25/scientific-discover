"""后端自测: 直接调用 llm.stream_chat, 不经过 HTTP。

用法:
  python selftest.py mock    # 测 mock 模式(不花钱)
  python selftest.py real    # 测真实 DeepSeek(花极少额度)
"""
import asyncio
import sys

from app import config


async def main(mode: str):
    if mode == "mock":
        config.settings.mock = True
    else:
        config.settings.mock = False

    # 延迟导入, 确保读取到上面改过的 settings
    from app.llm import stream_chat

    messages = [
        {"role": "system", "content": "你是简洁的助手, 只回一句话。"},
        {"role": "user", "content": "用一句话说明什么是消融实验。"},
    ]
    print(f"--- mode={mode} provider={config.settings.provider} "
          f"model={config.settings.model} mock={config.settings.mock} ---")
    buf = ""
    async for piece in stream_chat(messages):
        buf += piece
        print(piece, end="", flush=True)
    print("\n--- done, 总字符数:", len(buf), "---")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "mock"
    asyncio.run(main(mode))
