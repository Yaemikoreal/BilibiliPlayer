#!/usr/bin/env python3
"""B站扫码登录，保存凭证供 MCP Server 使用"""

import asyncio
import json
import os
from pathlib import Path
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

CRED_FILE = Path(__file__).parent / "bili_credential.json"

async def main():
    qr = QrCodeLogin()
    await qr.generate_qrcode()
    print(qr.get_qrcode_terminal())
    print("\n请用B站App扫描上方二维码（180秒内有效）\n")

    while True:
        try:
            state = await qr.check_state()
        except Exception as e:
            print(f"⚠️ 网络异常: {e}，5秒后重试...")
            await asyncio.sleep(5)
            continue
        if state == QrCodeLoginEvents.SCAN:
            print("✅ 已扫码，请在手机上确认...")
        elif state == QrCodeLoginEvents.CONF:
            print("✅ 已确认...")
        elif state == QrCodeLoginEvents.TIMEOUT:
            print("❌ 二维码超时，请重新运行")
            return
        elif state == QrCodeLoginEvents.DONE:
            break
        await asyncio.sleep(2)

    cred = qr.get_credential()
    tmp_file = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump({
            "sessdata": cred.sessdata,
            "bili_jct": cred.bili_jct,
            "buvid3": cred.buvid3,
            "dedeuserid": cred.dedeuserid,
        }, f, ensure_ascii=False)
    os.replace(tmp_file, CRED_FILE)
    print(f"\n🎉 登录成功！凭证已保存到 {CRED_FILE}")

if __name__ == "__main__":
    asyncio.run(main())
