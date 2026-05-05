import nodemailer from 'nodemailer';

export async function sendEmailViaTransport({ transportOpts, from, to, subject, text }) {
  const transporter = nodemailer.createTransport(transportOpts);
  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}
