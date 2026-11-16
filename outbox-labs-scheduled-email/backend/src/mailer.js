import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter;
let previewAccount;

export async function getTransporter() {
  if (transporter) return transporter;

  if (config.smtp.host && config.smtp.user && config.smtp.pass) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    return transporter;
  }

  if (!config.etherealAutoCreate) {
    throw new Error('Configure SMTP_* variables or set ETHEREAL_AUTO_CREATE=true');
  }

  previewAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: previewAccount.smtp.host,
    port: previewAccount.smtp.port,
    secure: previewAccount.smtp.secure,
    auth: { user: previewAccount.user, pass: previewAccount.pass },
  });
  console.log('[ethereal] test account:', previewAccount.user);
  return transporter;
}

export async function sendEmail({ to, subject, body }) {
  const transport = await getTransporter();
  const info = await transport.sendMail({
    from: config.smtp.user || previewAccount?.user || 'Outbox Demo <demo@ethereal.email>',
    to, subject, text: body,
  });
  const previewUrl = nodemailer.getTestMessageUrl(info);
  return { messageId: info.messageId, previewUrl: previewUrl || null };
}
