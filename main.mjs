import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'fs'
import fetch from 'node-fetch'

/**
 * Sends a notification message to a Telegram chat.
 */
async function sendTelegramMessage(message) {
    const botToken = process.env.TG_BOT_TOKEN
    const chatId = process.env.TG_CHAT_ID
    if (!botToken || !chatId) {
        console.warn('Telegram bot token or chat id not set, skipping notification.')
        return
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        })
        if (!res.ok) {
            console.error(`Failed to send Telegram message: ${res.status} ${res.statusText}`);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

/**
 * Uploads a local file to a WebDAV server and returns a status message.
 * @returns {Promise<string>} A status message for the notification.
 */
async function uploadToWebDAV(localFile, remoteFile) {
    const webdavUrl = process.env.WEBDAV_URL
    const webdavUser = process.env.WEBDAV_USERNAME
    const webdavPass = process.env.WEBDAV_PASSWORD
    if (!webdavUrl || !webdavUser || !webdavPass) {
        console.log('WebDAV is not configured, skipping upload.')
        return '' // Return empty if not configured
    }

    const webdavSavePath = process.env.WEBDAV_SAVE_PATH || ''
    const remoteDir = webdavSavePath.replace(/\/$/, '')
    const fullRemotePath = remoteDir ? `${remoteDir}/${remoteFile}` : remoteFile
    const url = `${webdavUrl.replace(/\/$/, '')}/${fullRemotePath}`
    
    try {
        const fileStream = fs.createReadStream(localFile)
        const stat = fs.statSync(localFile)
        const basicAuth = Buffer.from(`${webdavUser}:${webdavPass}`).toString('base64')

        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Length': stat.size, 'Authorization': `Basic ${basicAuth}` },
            body: fileStream
        })

        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`)
        
        console.log('WebDAV upload successful:', url)
        return `✅ 录屏已成功上传到 WebDAV。\n路径: \`${fullRemotePath}\``
    } catch (error) {
        console.error('WebDAV upload error:', error.message)
        return `❌ WebDAV 上传失败: \`${error.message}\``
    }
}

/**
 * Fetches the expiration date from the current page.
 */
async function getExpirationDate(page) {
    // ... (此函数未修改，保持原样)
    try {
        return await page.evaluate(() => {
            const ths = Array.from(document.querySelectorAll('th'));
            for (const th of ths) {
                if (th.textContent.trim() === '利用期限') {
                    const td = th.nextElementSibling;
                    if (td) {
                        const match = td.textContent.match(/\d{4}年\d{2}月\d{2}日/);
                        return match ? match[0].trim() : td.textContent.trim();
                    }
                }
            }
            return '';
        });
    } catch (error) {
        console.error("Could not evaluate getExpirationDate:", error);
        return '';
    }
}

// 生成北京时间字符串
function getBeijingTimeString() {
    const dt = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}-${String(dt.getMinutes()).padStart(2, '0')}`;
}

// --- Main Script ---

const browser = await puppeteer.launch({
    defaultViewport: {width: 1280, height: 1024},
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage();
const recordingPath = 'recording.webm'
const recorder = await page.screencast({ path: recordingPath })

let lastExpireDate = ''
const expireDateFile = 'expire.txt'
let infoMessage = ''
let scriptErrorMessage = '' // 用于存储错误信息

try {
    if (fs.existsSync(expireDateFile)) {
        lastExpireDate = fs.readFileSync(expireDateFile, 'utf8').trim()
    }

    console.log('Navigating and logging in...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('text=ログインする')
    ]);

    console.log('Navigating to VPS panel...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' })

    console.log('Starting renewal process...')
    await page.click('.contract__menuIcon')
    await page.click('text=契約情報')
    await page.click('text=更新する')
    await page.click('text=引き続き無料VPSの利用を継続する')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    
    const notYetTimeMessage = await page.evaluate(() => document.body.innerText.includes('利用期限の1日前から更新手続きが可能です'));

    if (notYetTimeMessage) {
        console.log('Not yet time for renewal.');
        const currentExpireDate = await getExpirationDate(page);
        infoMessage = `🗓️ 未到续费时间\n\n网站提示需要到期前一天才能操作。\n当前到期日: \`${currentExpireDate || '无法获取'}\`\n脚本将安全退出。\n\n北京时间: ${getBeijingTimeString().replace('_', ' ')}`;
        console.log(infoMessage);
        // 不立即发送，等待录屏上传后统一通知
    } else {
        console.log('Proceeding with the final renewal step...');
        await page.click('text=無料VPSの利用を継続する')
        await page.waitForNavigation({ waitUntil: 'networkidle2' })
        console.log('Returned to panel after renewal.');

        const newExpireDate = await getExpirationDate(page);
        console.log(`Found expiration date: ${newExpireDate || 'Not Found'}`);

        if (newExpireDate && newExpireDate !== lastExpireDate) {
            const successMessage = `🎉 VPS 续费成功！\n\n- 新到期日: \`${newExpireDate}\`\n- 上次到期日: \`${lastExpireDate || '首次检测'}\`\n\n北京时间: ${getBeijingTimeString().replace('_', ' ')}`;
            console.log(successMessage)
            infoMessage = successMessage;
            fs.writeFileSync(expireDateFile, newExpireDate)
        } else if (newExpireDate) {
            const failMessage = `⚠️ VPS 续费失败或未执行！\n\n到期日未发生变化，当前仍为: \`${newExpireDate}\`\n请检查录屏或日志确认续期流程是否正常。\n\n北京时间: ${getBeijingTimeString().replace('_', ' ')}`;
            console.warn(failMessage)
            infoMessage = failMessage;
        } else {
            throw new Error('无法找到 VPS 到期日。续期后未能定位到期日，脚本可能需要更新。');
        }
    }

} catch (e) {
    console.error('An error occurred during the renewal process:', e)
    scriptErrorMessage = `🚨 **VPS 续期脚本执行出错** 🚨\n\n错误信息: \`${e.message}\`\n\n北京时间: ${getBeijingTimeString().replace('_', ' ')}`
} finally {
    console.log('Script finished. Closing browser and saving recording.')
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()

    let finalNotification = ''
    let webdavMessage = ''

    if (fs.existsSync(recordingPath)) {
        const timestamp = getBeijingTimeString();
        const remoteFileName = `vps-renewal_${timestamp}.webm`
        webdavMessage = await uploadToWebDAV(recordingPath, remoteFileName)
    }

    // 合并最终通知消息
    if (scriptErrorMessage) {
        finalNotification = scriptErrorMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
    } else if (infoMessage) {
        finalNotification = infoMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
    } else if (webdavMessage) {
        finalNotification = webdavMessage;
    }

    if (finalNotification) {
        await sendTelegramMessage(finalNotification);
    }
}
