import type { CustomMessageTriggerHandler } from 'aws-lambda';

type EmailBrand = {
  accent: string;
  heading: string;
  name: string;
  panel: string;
  text: string;
};

const emailBrand = (): EmailBrand => {
  if (process.env.PRODUCT_BRAND === 'eversally') {
    return {
      name: 'Eversally',
      heading: 'Creativity, everywhere.',
      accent: '#7756a8',
      panel: '#f4effa',
      text: '#21182f'
    };
  }

  return {
    name: 'Ubeeq',
    heading: 'Your creative space, on your terms.',
    accent: '#0f766e',
    panel: '#eaf6f4',
    text: '#102a2a'
  };
};

const copyFor = (triggerSource: string | undefined, brand: EmailBrand) => {
  switch (triggerSource) {
    case 'CustomMessage_ForgotPassword':
      return {
        subject: `Reset your ${brand.name} password`,
        title: 'Reset your password',
        message: 'Use this code to reset your password. Do not share it with anyone.'
      };
    case 'CustomMessage_Authentication':
      return {
        subject: `Your ${brand.name} sign-in code`,
        title: 'Your sign-in code',
        message: 'Use this code to finish signing in. Do not share it with anyone.'
      };
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return {
        subject: `Confirm your ${brand.name} email`,
        title: 'Confirm your email',
        message: 'Use this code to confirm this email address for your account.'
      };
    case 'CustomMessage_AdminCreateUser':
      return {
        subject: `Your ${brand.name} account details`,
        title: 'Finish setting up your account',
        message: 'Use the details below to finish setting up your account.'
      };
    case 'CustomMessage_ResendCode':
    case 'CustomMessage_SignUp':
    default:
      return {
        subject: `Confirm your ${brand.name} account`,
        title: 'Confirm your email',
        message: `Use this code to verify your email and finish setting up your ${brand.name} account.`
      };
  }
};

/**
 * Branded Cognito message templates for confirmation, password reset, and
 * passwordless/MFA authentication codes. Cognito substitutes {####} at send
 * time; the template deliberately contains no user-provided HTML.
 */
export const handler: CustomMessageTriggerHandler = async (event) => {
  const brand = emailBrand();
  const copy = copyFor(event.triggerSource, brand);
  const code = event.request.codeParameter || '{####}';

  event.response.emailSubject = copy.subject;
  event.response.emailMessage = `<div style="margin:0;padding:32px 16px;background:#f7f7f8;font-family:Arial,Helvetica,sans-serif;color:${brand.text}"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e2e7;border-radius:16px;overflow:hidden"><div style="padding:28px 32px;background:${brand.panel};border-bottom:4px solid ${brand.accent}"><div style="font-size:24px;font-weight:700;color:${brand.accent}">${brand.name}</div><div style="margin-top:6px;font-size:14px;color:${brand.text}">${brand.heading}</div></div><div style="padding:32px"><h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:${brand.text}">${copy.title}</h1><p style="margin:0;font-size:16px;line-height:1.55;color:${brand.text}">${copy.message}</p><div style="margin:28px 0;padding:18px;background:${brand.panel};border-radius:10px;color:${brand.text};font-size:28px;font-weight:700;letter-spacing:5px;text-align:center">${code}</div><p style="margin:0;font-size:13px;line-height:1.5;color:#625d69">If you did not request this, you can safely ignore this email.</p></div></div></div>`;
  return event;
};
