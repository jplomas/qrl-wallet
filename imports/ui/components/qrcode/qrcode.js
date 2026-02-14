import { Template } from 'meteor/templating'
import './qrcode.html'

Template.QRCode.onRendered(function () {
  const instance = this
  const text = instance.data.text || ''
  const size = parseInt(instance.data.size, 10) || 128
  
  // Use the jQuery qrcode plugin
  if (text && instance.$('.qr-code').length) {
    instance.$('.qr-code').empty().qrcode({
      text: text,
      width: size,
      height: size,
      background: '#ffffff',
      foreground: '#000000'
    })
  }
})

Template.QRCode.helpers({
  size() {
    return Template.instance().data.size || '128px'
  }
})
